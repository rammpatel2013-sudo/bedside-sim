"""Copy the Learn pages into a checkout of the gh-pages branch (the HALO Teaching Tools web app).

    git worktree add ../pages origin/gh-pages
    python3 tools/publish_pages.py ../pages
    cd ../pages && git add -A && git commit -m "Publish Learn <sha>" && git push origin HEAD:gh-pages

static/learn/*.html stay the single source: the bedside-sim server serves them at /learn/, and this
script adds the web-app tags (manifest, home-screen icon, offline cache) to the published copies.
Add any new learn page to SHELL in sw.js on the gh-pages branch and bump its VERSION.
"""
import glob
import os
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


def webapp(html, root):
    if 'rel="manifest"' in html:
        return html
    i = html.index("</title>") + len("</title>")
    html = html[:i] + "\n" + HEAD.format(root=root) + html[i:].lstrip("\n")
    j = html.rindex("</body>")
    return html[:j] + SW.format(root=root) + html[j:]


def main(dest):
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "learn")
    os.makedirs(os.path.join(dest, "learn"), exist_ok=True)
    for f in sorted(glob.glob(os.path.join(src, "*.html"))):
        out = os.path.join(dest, "learn", os.path.basename(f))
        with open(f, encoding="utf-8") as fh:
            html = webapp(fh.read(), "../")
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(html)
        print("published", os.path.relpath(out, dest))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../pages")
