#!/usr/bin/env python
"""Write a reel storyboard with Claude (Anthropic API): topic (or your own script) -> storyboard.json.

Claude gets the storyboard rules and a worked example (src/reel/example_storyboard.json), writes a
storyboard, and every draft is checked with the same rules the renderer uses (cue words spoken in
their beat, known scenes and icons, item limits...). Problems are sent back to Claude to fix, up to
--attempts times. Render afterwards with  bash src/make_reel.sh reels/<name>/storyboard.json

Needs ANTHROPIC_API_KEY, from the environment or the project's .env.

    env/reel/bin/python src/reel/write_storyboard.py --name rag_intro --face-template template.json \
        --topic "What retrieval-augmented generation is, for beginners"
    env/reel/bin/python src/reel/write_storyboard.py --name my_talk --face-template template.json \
        --script inputs/scripts/my_talk.txt

Options: --seconds (target length, default 45), --model (default claude-opus-5-5), --notes, --force
(overwrite), --dry-run (print the prompt only), --check FILE (only validate an existing storyboard).
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EXAMPLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "example_storyboard.json")
DEFAULT_MODEL = "claude-opus-5-5"

# Must match src/reel/stage/icons.js and scenes.js.
ICONS = ["chat", "bulb", "pencil", "sparkles", "cap", "mail", "doc", "target", "globe", "code",
         "alert", "check", "shield", "star", "clock", "rocket"]
SCENE_MAX = {"checklist": 5, "grid": 6, "chat": 4, "callout": 3}
WORDS_PER_SECOND = 2.3  # the cloned voice speaks about 2.3 words per second, pauses included


# ---------------------------------------------------------------- validation

def norm(text: str) -> str:
    """Same as norm() in src/reel/timing.py: letters and digits only, lower case."""
    return re.sub(r"[^a-z0-9]+", "", text.lower().replace("’", "'"))


def cue_problem(cue, lines, where):
    if not isinstance(cue, str) or not cue.strip():
        return f"{where}: needs a cue word (the spoken word that makes it appear)"
    target, _, nth_raw = cue.strip().partition("#")
    try:
        nth = int(nth_raw) if nth_raw else 1
    except ValueError:
        nth = 0
    if not norm(target) or nth < 1:
        return f'{where}: cue "{cue}" should look like word or word#2'
    hits = sum(1 for w in " ".join(lines).split() if norm(w) == norm(target))
    if hits < nth:
        spoken = " ".join(lines)
        if nth == 1:
            return f'{where}: cue "{cue}" is not one of the words spoken in this beat ({spoken!r})'
        return f'{where}: cue "{cue}" needs "{target}" said {nth} times in this beat (found {hits})'
    return None


def text(v):
    return isinstance(v, str) and v.strip() != ""


def validate(sb) -> list[str]:
    """Problems that would make timing.py or the stage fail, or the reel look broken."""
    out = []
    if not isinstance(sb, dict):
        return ["the storyboard must be a JSON object"]
    if not re.fullmatch(r"[a-z0-9_]{1,48}", str(sb.get("name", ""))):
        out.append('"name" must be lower-case letters, digits or _')
    if "music" in sb and not (text(sb["music"]) and len(sb["music"]) <= 400):
        out.append('"music" must be a one-sentence brief (at most 400 characters)')
    beats = sb.get("beats")
    if not isinstance(beats, list) or not beats:
        return out + ['"beats" must be a non-empty list']
    ids = set()
    for i, b in enumerate(beats):
        at = f"beat {i + 1}"
        if not isinstance(b, dict):
            out.append(f"{at}: must be an object")
            continue
        bid = str(b.get("id", ""))
        at = f"beat {i + 1} ({bid or 'no id'})"
        if not re.fullmatch(r"[a-z0-9_]{1,32}", bid):
            out.append(f'{at}: id must be lower-case letters, digits or _')
        if bid in ids:
            out.append(f"{at}: id is used twice")
        ids.add(bid)
        lines = b.get("lines")
        if not isinstance(lines, list) or not lines or not all(text(l) for l in lines):
            out.append(f"{at}: needs at least one spoken line, and no empty lines")
            continue
        if any("\n" in l for l in lines):
            out.append(f"{at}: a line must not contain a line break (use separate lines)")

        def check(cue, where, optional=False):
            if optional and cue in (None, ""):
                return
            p = cue_problem(cue, lines, f"{at}, {where}")
            if p:
                out.append(p)

        if b.get("type") == "face":
            o = b.get("overlay")
            if o is None:
                pass
            elif not isinstance(o, dict) or o.get("kind") not in ("lower_third", "keywords"):
                out.append(f'{at}: overlay kind must be "lower_third" or "keywords"')
            elif o["kind"] == "lower_third":
                if not text(o.get("title")):
                    out.append(f"{at}: the lower third needs a title")
                check(o.get("cue"), "lower third", optional=True)
            else:
                items = o.get("items")
                if not isinstance(items, list) or not items:
                    out.append(f"{at}: keywords overlay needs at least one item")
                else:
                    if len(items) > 4:
                        out.append(f"{at}: keywords overlay fits at most 4 items")
                    for j, k in enumerate(items):
                        if not isinstance(k, dict) or not text(k.get("label")):
                            out.append(f"{at}, keyword {j + 1}: needs a label")
                            continue
                        check(k.get("cue"), f"keyword {j + 1}")
            continue

        if b.get("type") not in ("visual", "split"):
            out.append(f'{at}: type must be "face", "split" or "visual"')
            continue
        scene = b.get("scene")
        if scene not in SCENE_MAX:
            out.append(f"{at}: scene must be one of {', '.join(SCENE_MAX)}")
            continue
        d = b.get("data")
        if not isinstance(d, dict):
            out.append(f"{at}: needs a data object")
            continue
        if not text(d.get("title")):
            out.append(f"{at}: needs a title")
        key = {"chat": "messages", "callout": "points"}.get(scene, "items")
        items = d.get(key)
        if not isinstance(items, list) or not items:
            out.append(f'{at}: a {scene} needs a non-empty "{key}" list')
            continue
        if len(items) > SCENE_MAX[scene]:
            out.append(f"{at}: a {scene} fits at most {SCENE_MAX[scene]} {key}")
        for j, it in enumerate(items):
            where = f"{key[:-1]} {j + 1}"
            if not isinstance(it, dict):
                out.append(f"{at}, {where}: must be an object")
                continue
            if scene == "chat":
                if it.get("role") not in ("user", "assistant"):
                    out.append(f'{at}, {where}: role must be "user" or "assistant"')
                if not text(it.get("text")):
                    out.append(f"{at}, {where}: needs text")
            else:
                if not text(it.get("label")):
                    out.append(f"{at}, {where}: needs a label")
                if it.get("icon") not in ICONS:
                    out.append(f'{at}, {where}: icon "{it.get("icon")}" is not one of {", ".join(ICONS)}')
                if scene == "callout" and it.get("tone", "warn") not in ("warn", "good"):
                    out.append(f'{at}, {where}: tone must be "warn" or "good"')
            check(it.get("cue"), where)
        if scene == "checklist":
            c = d.get("conclusion")
            if not isinstance(c, dict) or not text(c.get("title")):
                out.append(f"{at}: a checklist needs a conclusion with a title (all rows tick on it)")
            else:
                check(c.get("cue"), "conclusion")
        if scene == "callout":
            check(d.get("title_cue"), "title_cue", optional=True)
            if d.get("icon") not in (None, *ICONS):
                out.append(f'{at}: callout icon "{d.get("icon")}" is unknown')
    return out


def summary(sb) -> str:
    words = sum(len(l.split()) for b in sb["beats"] for l in b["lines"])
    face = sum(len(l.split()) for b in sb["beats"] if b["type"] in ("face", "split") for l in b["lines"])
    faces = sum(1 for b in sb["beats"] if b["type"] in ("face", "split"))
    return (f"{len(sb['beats'])} beats ({faces} on camera), {words} words (about {words / WORDS_PER_SECOND:.0f} s), "
            f"avatar on screen about {face / WORDS_PER_SECOND:.0f} s")


# ---------------------------------------------------------------- prompt

RULES = """You write storyboards for short vertical video reels (1080x1920, 25 fps). The speaker is a
talking avatar of the user, voiced by a clone of their own voice. One continuous speech track runs
under the whole reel; the picture cuts between three layouts: the avatar full screen ("face"), an
animated graphic on top with the avatar in the bottom half ("split"), and a graphic full screen
("visual"). Word-by-word captions and sound effects are added automatically. These are social media
reels, not presentations: energetic, fast and made to hold attention.

Reply with ONE JSON object and nothing else: no prose, no markdown fences.

Top level: "name", "topic", "face_template", "fps": 25, "tail": 0.6, "music", "beats": [...].
"music": one sentence briefing a music model on the instrumental background that suits this video:
mood, genre, tempo in BPM and two or three instruments, always ending "no vocals". It should feel
like a social media reel: upbeat and energetic with a clear groove (about 110-128 BPM, punchy drums,
catchy synth or bass), not calm background music. It sits under the voice and rises in the pauses.

Each beat: "id" (lower-case letters, digits, _; unique), "type" ("face", "split" or "visual"),
"lines" (list of strings: the exact words spoken during the beat, in order).

face beat: the avatar speaks on camera. Optional "overlay":
  {"kind": "lower_third", "title": "...", "subtitle": "...", "cue": "word"}   (cue optional)
  {"kind": "keywords", "items": [{"label": "...", "cue": "word"}, ...]}       (1-4 pills)

visual or split beat: "scene" plus "data" (a split beat shows the same scene, smaller, above the
avatar). Every data object has "kicker" (2-3 word label above the title)
and "title" (short headline). Per scene:
  checklist  "items": 2-5 x {"icon", "label", "cue"}, plus "conclusion": {"title", "cue"} - rows slide
             in on their cues, then all tick off when the conclusion cue is spoken (so the
             conclusion cue must come after the item cues).
  grid       "items": 2-6 x {"icon", "label", "cue"} - tiles pop in, two columns.
  chat       "messages": 2-4 x {"role": "user"|"assistant", "text", "cue"} - a chat window whose
             messages type themselves. Keep texts short (assistant under ~110 characters).
  callout    "points": 1-3 x {"icon", "tone": "warn"|"good", "label", "cue"}, optional "title_cue" -
             a pulsing warning badge; use it for caveats and warnings.
Icons (only these): ICONS.

Cues (the most important rule): a "cue" names ONE word that is spoken in that same beat's lines;
the element appears the moment that word is said. Write the word exactly as it appears in the line
(case and punctuation do not matter). If the word occurs more than once in the beat, "word#2" means
its second occurrence. Choose cues so elements appear in the order they are listed, and pick a
distinctive content word, not "the" or "a".

Writing the lines:
- Spoken, first person, natural and warm; this is the user talking to their audience.
- About TARGET_WORDS words in total (TARGET_SECONDS seconds at 2.3 words per second).
- Open with a strong hook in the first sentence: a face beat, usually with a lower_third naming
  the topic. End with a face beat (a short wrap-up or call to action, often a keywords overlay).
- In between, mix all three layouts and keep the avatar coming back: mostly split beats, with a
  full visual beat now and then for variety. Never put two face beats or more than two visual
  beats in a row. Keep beats short (1-2 sentences) so the picture changes every few seconds.
- The avatar costs $0.05 per second on screen (face and split beats), so face + split beats together
  should be at most about 70% of the words.
- One visual beat = one idea, 1-3 sentences. Labels on screen should be short (2-5 words) and
  echo what is being said.
- Spell out numbers and symbols as they should be spoken ("twenty percent", not "20%"); avoid
  URLs, emoji, abbreviations the voice would mispronounce, and line breaks inside a line.
- Be accurate. Do not invent statistics, quotes or product claims."""


def build_prompt(args, example: str) -> tuple[str, str]:
    target_words = round(args.seconds * WORDS_PER_SECOND)
    system = (RULES.replace("ICONS", ", ".join(ICONS))
              .replace("TARGET_WORDS", str(target_words)).replace("TARGET_SECONDS", str(args.seconds)))
    system += "\n\nA finished storyboard that rendered well (follow its style and structure):\n" + example
    if args.script:
        with open(args.script, encoding="utf-8") as f:
            script = f.read().strip()
        task = ("Turn this script into a storyboard. Keep the spoken words exactly as written (you may "
                "only split them into lines and beats, and spell out numbers or symbols); design the "
                "beats, scenes, overlays and cues around them. Ignore the target length.\n\n"
                f"SCRIPT:\n{script}")
    else:
        task = f"Write the script and storyboard for a reel about: {args.topic}"
    if args.notes:
        task += f"\n\nExtra instructions from the user: {args.notes}"
    task += (f'\n\nUse "name": "{args.name}", "face_template": "{args.face_template}", '
             f'and a short "topic".')
    return system, task


# ---------------------------------------------------------------- Claude

def load_key() -> None:
    """Put ANTHROPIC_API_KEY from the project's .env into the environment, where the SDK reads it."""
    env_path = os.path.join(ROOT, ".env")
    if not os.environ.get("ANTHROPIC_API_KEY") and os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                k, sep, v = line.strip().partition("=")
                if sep and k.strip() == "ANTHROPIC_API_KEY" and v.strip():
                    os.environ["ANTHROPIC_API_KEY"] = v.strip().strip('"').strip("'")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit(f"ANTHROPIC_API_KEY is empty: put it in {env_path} (ANTHROPIC_API_KEY=sk-ant-...)")


def call(client, model: str, system: str, messages: list[dict]):
    """One draft. Streams (long outputs), falls back to another model if this one declines."""
    import anthropic

    try:
        with client.beta.messages.stream(
            model=model, max_tokens=32000, system=system, messages=messages,
            output_config={"effort": "high"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError:
        sys.exit("the Anthropic API rejected ANTHROPIC_API_KEY; check the key in .env")
    except anthropic.RateLimitError:
        sys.exit("the Anthropic API is rate limiting this key; try again in a minute")
    except anthropic.APIStatusError as e:
        sys.exit(f"the Anthropic API returned HTTP {e.status_code}: {str(e.message)[:500]}")
    except anthropic.APIConnectionError:
        sys.exit("could not reach the Anthropic API")
    if msg.stop_reason == "refusal":
        sys.exit("Claude declined to design this script; change the wording and try again")
    if msg.stop_reason == "max_tokens":
        print("[warn] the draft was cut off at the token limit")
    text = "".join(b.text for b in msg.content if b.type == "text")
    return msg, text


def parse(reply: str):
    reply = reply.strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", reply, re.S)
    if fence:
        reply = fence.group(1)
    try:
        return json.loads(reply), None
    except json.JSONDecodeError as e:
        start, end = reply.find("{"), reply.rfind("}")
        if 0 <= start < end:
            try:
                return json.loads(reply[start:end + 1]), None
            except json.JSONDecodeError:
                pass
        return None, f"the reply is not valid JSON ({e})"


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--name", help="reel name; output goes to reels/<name>/storyboard.json")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--topic", help="what the reel is about; the model writes the script")
    src.add_argument("--script", help="text file with your own script; its words are kept")
    ap.add_argument("--notes", help="extra instructions (audience, tone, points to cover)")
    ap.add_argument("--seconds", type=int, default=45, help="target length when writing from a topic")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--face-template", help="the avatar's photo and description (JSON with cond_image and prompt)")
    ap.add_argument("--attempts", type=int, default=3, help="drafts before giving up")
    ap.add_argument("--force", action="store_true", help="overwrite an existing storyboard")
    ap.add_argument("--dry-run", action="store_true", help="print the prompt and exit")
    ap.add_argument("--check", metavar="FILE", help="only validate an existing storyboard")
    args = ap.parse_args()

    if args.check:
        with open(args.check, encoding="utf-8") as f:
            sb = json.load(f)
        problems = validate(sb)
        for p in problems:
            print(f"- {p}")
        print(f"{args.check}: " + ("OK, " + summary(sb) if not problems else f"{len(problems)} problem(s)"))
        sys.exit(1 if problems else 0)

    if not args.name or not args.face_template or not (args.topic or args.script):
        ap.error("--name, --face-template and one of --topic / --script are required")
    if not re.fullmatch(r"[a-z0-9_]{1,48}", args.name):
        ap.error("--name must be lower-case letters, digits or _")
    if not os.path.exists(os.path.join(ROOT, args.face_template)):
        ap.error(f"face template not found: {args.face_template}")
    out_path = os.path.join(ROOT, "reels", args.name, "storyboard.json")
    if os.path.exists(out_path) and not args.force and not args.dry_run:
        sys.exit(f"{os.path.relpath(out_path, ROOT)} already exists; pass --force to overwrite it")

    with open(EXAMPLE, encoding="utf-8") as f:
        example = json.load(f)
    system, task = build_prompt(args, json.dumps(example, indent=1, ensure_ascii=False))
    if args.dry_run:
        print(f"===== system\n{system}\n\n===== user\n{task}\n\nmodel: {args.model}")
        return

    import anthropic

    load_key()
    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": task}]
    for attempt in range(1, args.attempts + 1):
        print(f"draft {attempt}/{args.attempts} with {args.model} ...", flush=True)
        msg, reply = call(client, args.model, system, messages)
        sb, err = parse(reply)
        problems = [err] if err else validate(sb)
        if sb is not None and not problems:
            sb["name"], sb["face_template"] = args.name, args.face_template
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(sb, f, indent=4, ensure_ascii=False)
                f.write("\n")
            print(f"wrote {os.path.relpath(out_path, ROOT)}: {summary(sb)}")
            print(f"render it with:  bash src/make_reel.sh reels/{args.name}/storyboard.json")
            return
        print(f"  {len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        messages += [
            {"role": "assistant", "content": msg.content},  # thinking blocks go back unchanged
            {"role": "user", "content": "That storyboard has these problems:\n- " + "\n- ".join(problems)
             + "\nReply with the complete corrected storyboard JSON only."},
        ]
    sys.exit("no valid storyboard after all attempts; try again, or use --notes to steer the model")


if __name__ == "__main__":
    main()
