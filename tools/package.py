"""Package source and launcher with Unix permissions; never includes local state."""
from pathlib import Path
import hashlib
import zipfile

root = Path(__file__).resolve().parents[1]
release = root / "release"
release.mkdir(exist_ok=True)
files = [root / "Start.command", root / "Build-Identity.command", root / "README.md", root / "IDENTITY.md"]
for directory in ("src", "native", "tests", "tools"):
    files.extend(sorted(p for p in (root / directory).rglob("*") if p.is_file() and "__pycache__" not in p.parts))
archive = release / "Mac-Privacy-Toolkit-Intel-Sequoia.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
    for path in files:
        relative = Path("Mac Privacy Toolkit") / path.relative_to(root)
        info = zipfile.ZipInfo(relative.as_posix())
        info.create_system = 3
        info.external_attr = ((0o100755 if path.suffix == ".command" else 0o100644) << 16)
        info.compress_type = zipfile.ZIP_DEFLATED
        package.writestr(info, path.read_bytes().replace(b"\r\n", b"\n"))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(release / (archive.name + ".sha256")).write_text(f"{digest}  {archive.name}\n", encoding="ascii")
print(f"ZIP: {archive}")
print(f"SHA256: {digest}")
