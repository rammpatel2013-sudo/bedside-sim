"""Copy Vent Lab and the Learn pages into a checkout of the gh-pages branch (the HALO Teaching Tools web app).

    git worktree add ../pages origin/gh-pages
    python3 tools/publish_pages.py ../pages
    cd ../pages && git add -A && git commit -m "Publish <sha>" && git push origin HEAD:gh-pages

The GitHub Action .github/workflows/pages.yml runs exactly this on every push to main (after the
simulator tests pass), so publishing by hand is only needed for gh-pages-only files.

static/vent/ and static/learn/*.html stay the single source: the bedside-sim server serves them at
/vent/ and /learn/, and this script adds the web-app tags (manifest, home-screen icon, offline cache)
to the published copies. The web-app shell — index.html, manifest.webmanifest, icons/, sw.js — lives
only on the gh-pages branch and is left untouched, except that sw.js VERSION is set to the source
commit so installed copies drop their cached scripts and pick up the new ones.
Add any new learn page to SHELL in sw.js on the gh-pages branch if it should be precached offline.
"""
import glob
import os
import re
import shutil
import subprocess
import sys

HEAD = """<link rel="manifest" href="{root}manifest.webmanifest">
<meta name="theme-color" content="#13202a">
<link rel="apple-touch-icon" href="{root}icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="HALO">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
"""
SW = "<script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('{root}sw.js').catch(function () {{}});</script>\n"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def webapp(html, root):
    if 'rel="manifest"' in html:
        return html
    i = html.index("</title>") + len("</title>")
    html = html[:i] + "\n" + HEAD.format(root=root) + html[i:].lstrip("\n")
    j = html.rindex("</body>")
    return html[:j] + SW.format(root=root) + html[j:]


def publish_html(src, out, root):
    with open(src, encoding="utf-8") as fh:
        html = webapp(fh.read(), root)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)


def source_sha():
    sha = os.environ.get("GITHUB_SHA")
    if sha:
        return sha[:7]
    try:
        return subprocess.check_output(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], text=True).strip()
    except Exception:
        return "local"


def main(dest):
    # Learn: one self-contained HTML file per page
    os.makedirs(os.path.join(dest, "learn"), exist_ok=True)
    for f in sorted(glob.glob(os.path.join(ROOT, "static", "learn", "*.html"))):
        out = os.path.join(dest, "learn", os.path.basename(f))
        publish_html(f, out, "../")
        print("published", os.path.relpath(out, dest))

    # Vent Lab: index.html gets the web-app tags; scripts are copied as they are
    os.makedirs(os.path.join(dest, "vent"), exist_ok=True)
    for f in sorted(glob.glob(os.path.join(ROOT, "static", "vent", "*"))):
        out = os.path.join(dest, "vent", os.path.basename(f))
        if f.endswith(".html"):
            publish_html(f, out, "../")
        else:
            shutil.copyfile(f, out)
        print("published", os.path.relpath(out, dest))

    # Offline cache: new VERSION = new cache, so installed copies fetch the new scripts
    sw = os.path.join(dest, "sw.js")
    if os.path.isfile(sw):
        with open(sw, encoding="utf-8") as fh:
            js = fh.read()
        js, n = re.subn(r"const VERSION = '[^']*';", f"const VERSION = 'halo-{source_sha()}';", js, count=1)
        if n:
            with open(sw, "w", encoding="utf-8") as fh:
                fh.write(js)
            print("sw.js VERSION ->", f"halo-{source_sha()}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../pages")
