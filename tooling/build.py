"""Build and verify release files with the MetroFuse SDK toolkit."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "plugin"
TOOLKIT = ROOT / "tooling" / "metrofuse-plugin.py"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", action="store_true", help="Run the provider fixtures before packaging")
    args = parser.parse_args()
    plugin = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    name = plugin["id"].removeprefix("metrofuse.")
    if args.test:
        subprocess.run(["node", "--test", "tests/provider.test.mjs"], cwd=ROOT, check=True)
    with TemporaryDirectory(prefix="metrofuse-package-") as directory:
        working = Path(directory)
        staging = working / "plugin"
        artifact = working / f"{name}.mfp"
        shutil.copytree(SOURCE, staging)
        shutil.copyfile(ROOT / "LICENSE", staging / "LICENSE")
        subprocess.run([sys.executable, str(TOOLKIT), "pack", str(staging), str(artifact)], check=True)
        subprocess.run([sys.executable, str(TOOLKIT), "verify", str(artifact)], check=True)
        output = ROOT / "dist"
        output.mkdir(exist_ok=True)
        shutil.copyfile(artifact, output / artifact.name)
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        (output / "SHA256SUMS").write_text(f"{digest}  {artifact.name}\n", encoding="ascii", newline="\n")


if __name__ == "__main__":
    main()
