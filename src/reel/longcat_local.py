#!/usr/bin/env python
"""Run LongCat-Video-Avatar 1.6 (single person, audio to video) on one 32 GB GPU, at 480p or 720p.

render_face.py (engine longcat-local) starts this inside LongCat's own Python environment, from the
LongCat repo directory:
    torchrun --nproc_per_node=1 <project>/src/reel/longcat_local.py <run_demo_avatar_single_audio_to_video.py args>

Upstream keeps every model on the GPU at once (INT8 DiT with its LoRAs, the umT5-XXL text encoder,
Whisper large-v3, the VAE and the vocal separator), which needs more than 32 GB, and at 720p its
largest intermediate tensors do not fit next to the INT8 model either. The LongCat repo is left
untouched: this script patches it at run time and then runs the upstream script with the same arguments.

Memory:
1. The text encoder stays on the CPU. The prompt is encoded once, and upstream caches the result.
2. Whisper moves back to the CPU once the audio embedding has been computed.
3. The vocal separator runs on the CPU.
4. The INT8 DiT is loaded without first initialising a full float32 copy (about 54 GB) in system RAM:
   the Linear layers it replaces are left uninitialised, and the INT8 weights are loaded right after.

720p (same maths, a smaller peak):
5. Every LoRA-wrapped linear layer and every feed-forward layer runs over the tokens in chunks of
   LONGCAT_CHUNK tokens (default 4096) instead of all at once.
6. The 3D rotary embedding, which works on float32 copies of q and k, runs LONGCAT_ROPE_HEADS heads
   at a time (default 4).
"""
import gc
import os
import runpy
import sys

import torch
import torch.nn as nn
import torch.nn.functional as F

REPO = os.getcwd()
sys.path.insert(0, REPO)

from audio_separator.separator import Separator  # noqa: E402
from longcat_video.modules import blocks, quantization  # noqa: E402
from longcat_video.modules.avatar import longcat_video_dit_avatar as dit_avatar, rope_3d  # noqa: E402
from longcat_video.pipeline_longcat_video_avatar import LongCatVideoAvatarPipeline as Pipe  # noqa: E402

CHUNK = int(os.environ.get("LONGCAT_CHUNK", "4096"))
ROPE_HEADS = int(os.environ.get("LONGCAT_ROPE_HEADS", "4"))


def log(msg: str) -> None:
    print(f"[longcat_local] {msg}", flush=True)


# 1. text encoder on the CPU
_orig_to = Pipe.to
_orig_t5 = Pipe._get_t5_prompt_embeds


def _to_without_text_encoder(self, device):
    text_encoder, self.text_encoder = self.text_encoder, None
    try:
        return _orig_to(self, device)
    finally:
        self.text_encoder = text_encoder


def _t5_on_cpu(self, prompt=None, num_videos_per_prompt=1, max_sequence_length=512, device=None, dtype=None):
    if not hasattr(self, "_te_out_dtype"):
        self._te_out_dtype = self.text_encoder.dtype
        log("encoding the prompt with the text encoder on the CPU (float32)")
        self.text_encoder.to(device="cpu", dtype=torch.float32)
    embeds, mask = _orig_t5(self, prompt=prompt, num_videos_per_prompt=num_videos_per_prompt,
                            max_sequence_length=max_sequence_length, device=torch.device("cpu"), dtype=torch.float32)
    return embeds.to(device=device, dtype=dtype or self._te_out_dtype), mask.to(device=device)


# 2. Whisper off the GPU after use
_orig_audio_emb = Pipe.get_audio_embedding


def _audio_emb_then_offload(self, *args, **kwargs):
    out = _orig_audio_emb(self, *args, **kwargs)
    self.audio_encoder.to("cpu")
    gc.collect()
    torch.cuda.empty_cache()
    log(f"audio encoder moved to the CPU; {torch.cuda.memory_allocated() / 2**30:.1f} GiB now allocated on the GPU")
    return out


# 3. vocal separator on the CPU
_orig_sep_init = Separator.__init__


def _sep_init_cpu(self, *args, **kwargs):
    _orig_sep_init(self, *args, **kwargs)
    self.onnx_execution_provider = ["CPUExecutionProvider"]
    if hasattr(self, "torch_device_cpu"):
        self.torch_device = self.torch_device_cpu


# 4. INT8 DiT without the float32 copy
_orig_load_quantized = quantization.load_quantized_dit


def _load_quantized_low_ram(*args, **kwargs):
    orig_reset = nn.Linear.reset_parameters
    nn.Linear.reset_parameters = lambda self: None
    try:
        return _orig_load_quantized(*args, **kwargs)
    finally:
        nn.Linear.reset_parameters = orig_reset
        gc.collect()


# 5. linear and feed-forward layers over the tokens in chunks
_orig_make_lora = dit_avatar.LongCatVideoAvatarTransformer3DModel._create_multi_lora_forward


def _make_lora_chunked(self, module, loras):
    fwd = _orig_make_lora(self, module, loras)

    def chunked(x, *args, **kwargs):
        if x.dim() < 3 or x.shape[1] <= CHUNK:
            return fwd(x, *args, **kwargs)
        return torch.cat([fwd(c, *args, **kwargs) for c in x.split(CHUNK, dim=1)], dim=1)
    return chunked


def _ffn_chunked(self, x):
    if x.shape[1] <= CHUNK:
        return self.w2(F.silu(self.w1(x)) * self.w3(x))
    return torch.cat([self.w2(F.silu(self.w1(c)) * self.w3(c)) for c in x.split(CHUNK, dim=1)], dim=1)


# 6. rotary embedding a few heads at a time
_orig_rope = rope_3d.RotaryPositionalEmbedding.forward


def _rope_by_heads(self, q, k, *args, **kwargs):
    if q.shape[1] <= ROPE_HEADS:
        return _orig_rope(self, q, k, *args, **kwargs)
    parts = [_orig_rope(self, qc, kc, *args, **kwargs) for qc, kc in zip(q.split(ROPE_HEADS, dim=1), k.split(ROPE_HEADS, dim=1))]
    return torch.cat([p[0] for p in parts], dim=1), torch.cat([p[1] for p in parts], dim=1)


Pipe.to = _to_without_text_encoder
Pipe._get_t5_prompt_embeds = _t5_on_cpu
Pipe.get_audio_embedding = _audio_emb_then_offload
Separator.__init__ = _sep_init_cpu
quantization.load_quantized_dit = _load_quantized_low_ram
dit_avatar.LongCatVideoAvatarTransformer3DModel._create_multi_lora_forward = _make_lora_chunked
blocks.FeedForwardSwiGLU.forward = _ffn_chunked
rope_3d.RotaryPositionalEmbedding.forward = _rope_by_heads

if __name__ == "__main__":
    log(f"low-VRAM patches applied; linear layers in chunks of {CHUNK} tokens, rotary embedding {ROPE_HEADS} heads at a time")
    script = os.path.join(REPO, "run_demo_avatar_single_audio_to_video.py")
    sys.argv = [script] + sys.argv[1:]
    runpy.run_path(script, run_name="__main__")
