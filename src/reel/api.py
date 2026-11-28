"""Helpers shared by the pipeline scripts: API keys, HTTP requests to the cloud models, data URIs,
and the text normalisation that matches script words to what Whisper heard. Standard library only."""
import base64
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def need_key(name: str) -> str:
    """The API key from the environment, or else from the project's .env (so a script run directly
    without src/setup/common.sh still finds it). Exits when it is missing or empty."""
    key = os.environ.get(name, "").strip()
    env_path = os.path.join(ROOT, ".env")
    if not key and os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                k, sep, v = line.strip().partition("=")
                if sep and k.strip() == name and v.strip():
                    key = v.strip().strip('"').strip("'")
    if not key:
        sys.exit(f"Error: {name} is not set; put it in the project's .env")
    return key


def request(url: str, body=None, headers: dict | None = None, method: str | None = None, name: str = "the API",
            retries: int = 0) -> bytes:
    """One HTTP request: a dict body is sent as JSON, bytes as they are. Returns the response bytes and
    exits on an error. retries: extra tries after a 5xx or network error; keep 0 for a paid submit,
    which may already be billed."""
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    h = {"Content-Type": "application/json"} if isinstance(body, dict) else {}
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"), headers={**h, **(headers or {})})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == retries:
                sys.exit(f"Error: {name} returned HTTP {e.code}: {e.read().decode(errors='replace')[:400]}")
        except urllib.error.URLError as e:
            if attempt == retries:
                sys.exit(f"Error: could not reach {name}: {e.reason}")


def data_uri(path: str, mime: str | None = None) -> str:
    """The file as a base64 data URI; the type is guessed from the name unless given."""
    mime = mime or mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"


def norm(text: str) -> str:
    """Letters and digits only, lower case: what both the script and Whisper agree on."""
    return re.sub(r"[^a-z0-9]+", "", text.lower().replace("’", "'"))
