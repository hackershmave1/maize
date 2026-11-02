#!/usr/bin/env python3
"""Generate a tree of LARGE text files with real text (for the Moqesh World).

Fills directories like `/data` or `/files/<subdir>` with voluminous files made of
real paragraphs from public-domain books (Project Gutenberg, cached in ~/.cache/genbig)
or from your own corpus. Served by the World with `"autoindex": true`, they form a finite
but heavy "open directory" that burns an agent's tokens WITHOUT the giveaway of generated/
templated content (it is real text).

Typical use with Moqesh (the World lives next to the DB, e.g. /app/data/world):
  # /data with 50 files of 10 MiB
  python3 scripts/genbig.py /app/data/world/sites/data --files 50 --size 10M --lang en
  # /files/2023 /files/2024 /files/2025 (numeric subdirs)
  python3 scripts/genbig.py /app/data/world/sites/files --files 60 --size 10M \
      --subdirs 3 --subdir-prefix "" --subdir-width 4 --subdir-start 2023
Then add the mount to the World's manifest.json and restart:
  {"prefix": "/data", "dir": "sites/data", "autoindex": true}

Other examples:
  python3 scripts/genbig.py output --files 20 --size 5G --lang es
  python3 scripts/genbig.py output --files 10 --size 2G --corpus my_texts.txt --unique
"""
import argparse
import os
import random
import re
import sys
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed

BLOCK = 1 << 20  # 1 MiB per block
POOL_BLOCKS = 64  # pre-generated blocks per worker
CACHE = os.path.expanduser("~/.cache/genbig")

BOOKS = {
    # Crime and Punishment, Les Miserables 2, Don Quixote, Tales of Love, Insolation and Morrina,
    # The Odyssey, The Argonauts, The Divine Comedy, Paradise Lost, Jose
    "es": [61851, 78068, 2000, 55514, 52597, 58221, 25640, 57303, 67092, 27738],
    # Pride and Prejudice, Moby Dick, Frankenstein, Alice, Sherlock Holmes, Dracula,
    # Crime and Punishment, Middlemarch, Little Women, Jane Eyre, Dorian Gray, Monte Cristo, Two Cities
    "en": [1342, 2701, 84, 11, 1661, 345, 2554, 145, 37106, 1260, 174, 1184, 98],
}


def parse_size(s):
    s = s.strip().upper().rstrip("B")
    mult = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}
    if s and s[-1] in mult:
        return int(float(s[:-1]) * mult[s[-1]])
    return int(s)


def download_books(lang):
    """Download the books (if not cached) and return their paths."""
    os.makedirs(CACHE, exist_ok=True)
    langs = ["es", "en"] if lang == "mix" else [lang]
    paths = []
    for lng in langs:
        for bid in BOOKS[lng]:
            path = os.path.join(CACHE, f"pg{bid}.txt")
            if not os.path.exists(path):
                url = f"https://www.gutenberg.org/cache/epub/{bid}/pg{bid}.txt"
                print(f"Downloading {url}")
                try:
                    with urllib.request.urlopen(url, timeout=60) as r, open(path + ".part", "wb") as f:
                        f.write(r.read())
                    os.replace(path + ".part", path)
                except Exception as e:
                    print(f"  warning: could not download ({e}), skipping")
                    continue
            paths.append(path)
    if not paths:
        sys.exit("Could not download any book.")
    return paths


def load_paragraphs(paths):
    """Read the texts, strip the Gutenberg header/license and join each paragraph's lines."""
    paras = []
    for p in paths:
        with open(p, encoding="utf-8", errors="ignore") as f:
            text = f.read().replace("\r\n", "\n")
        start = re.search(r"\*\*\* ?START OF.*?\*\*\*", text)
        end = re.search(r"\*\*\* ?END OF", text)
        if start:
            text = text[start.end() : end.start() if end else None]
        for para in re.split(r"\n\s*\n", text):
            para = " ".join(para.split())
            # drop titles, chapter numbers, short lines and transcriber's notes
            low = para.lower()
            if len(para) >= 80 and not any(k in low for k in ("gutenberg", "http", "e-text", "ebook")):
                paras.append(para)
    return paras


def make_block(rng, paras):
    out, size = [], 0
    while size < BLOCK:
        p = rng.choice(paras) + "\n\n"
        out.append(p)
        size += len(p.encode())
    return "".join(out).encode()


def write_file(path, size, sources, seed, unique):
    rng = random.Random(seed)
    paras = load_paragraphs(sources)
    pool = None if unique else [make_block(rng, paras) for _ in range(POOL_BLOCKS)]
    written = 0
    with open(path, "wb", buffering=8 * BLOCK) as f:
        while written < size:
            blk = make_block(rng, paras) if unique else rng.choice(pool)
            blk = blk[: size - written]
            f.write(blk)
            written += len(blk)
    return path, written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("outdir")
    ap.add_argument("--files", type=int, default=10, help="number of files")
    ap.add_argument("--size", default="100M", help="size per file (K/M/G/T)")
    ap.add_argument("--lang", choices=["es", "en", "mix"], default="en", help="text language")
    ap.add_argument("--corpus", nargs="+", help="use your own .txt files instead of Gutenberg")
    ap.add_argument("--unique", action="store_true", help="generate every block fresh (less repetition, slower)")
    ap.add_argument("--subdirs", type=int, default=0, help="spread across N subdirectories")
    ap.add_argument("--subdir-prefix", default="dir_", help="subdirectory prefix ('' for /0023, /2023...)")
    ap.add_argument("--subdir-width", type=int, default=4, help="digits in the subdirectory index")
    ap.add_argument("--subdir-start", type=int, default=0, help="starting subdirectory index (e.g. 2023)")
    ap.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()

    size = parse_size(a.size)
    total = size * a.files
    os.makedirs(a.outdir, exist_ok=True)
    st = os.statvfs(a.outdir)
    free = st.f_bavail * st.f_frsize
    if total > free:
        sys.exit(f"Not enough space: {total / 2**30:.1f} GiB needed, {free / 2**30:.1f} GiB available")

    sources = [os.path.abspath(c) for c in a.corpus] if a.corpus else download_books(a.lang)
    if not load_paragraphs(sources):
        sys.exit("The source texts have no usable paragraphs.")

    base_seed = a.seed if a.seed is not None else random.randrange(2**32)
    jobs = []
    for i in range(a.files):
        if a.subdirs:
            n = a.subdir_start + (i % a.subdirs)
            d = os.path.join(a.outdir, f"{a.subdir_prefix}{n:0{a.subdir_width}d}")
        else:
            d = a.outdir
        os.makedirs(d, exist_ok=True)
        jobs.append((os.path.join(d, f"file_{i:06d}.txt"), size, sources, base_seed + i, a.unique))

    print(f"Generating {a.files} files x {a.size} = {total / 2**30:.2f} GiB with {a.workers} workers...")
    t0, done_bytes = time.time(), 0
    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(write_file, *j) for j in jobs]
        for n, fut in enumerate(as_completed(futs), 1):
            _, w = fut.result()
            done_bytes += w
            el = time.time() - t0
            print(
                f"\r[{n}/{a.files}] {done_bytes / 2**30:.2f} GiB  "
                f"{done_bytes / 2**20 / max(el, 1e-9):.0f} MiB/s",
                end="",
                flush=True,
            )
    print(f"\nDone in {time.time() - t0:.1f}s -> {a.outdir}")


if __name__ == "__main__":
    main()
