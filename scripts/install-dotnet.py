"""Optional Linux x64 .NET SDK, exact release with pinned official SHA-512."""
import hashlib
import os
import platform
import subprocess
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

VERSION = "10.0.402"
URL = f"https://builds.dotnet.microsoft.com/dotnet/Sdk/{VERSION}/dotnet-sdk-{VERSION}-linux-x64.tar.gz"
SHA512 = "1904a98dda2db34ba78ba3c4fb1b224455329af91c341d83547843c1839e112b04ae699ee92fa2449a8f62249196a938723078c0c60b9f65c88539d5687729c2"
target = Path(os.environ.get("PANELTECH_DOTNET_DIR", "/workspace/.tools/dotnet"))
if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
    raise SystemExit("This optional installer supports Linux x64 only; use the official .NET 10 installer on Windows.")
installed = (target / "dotnet").exists() and VERSION in [line.split()[0] for line in subprocess.check_output([str(target / "dotnet"), "--list-sdks"], text=True).splitlines()]
if installed:
    print(f"Using existing SDK at {target}; setup verifies its version.")
else:
    with tempfile.TemporaryDirectory(prefix="paneltech-sdk-") as temp:
        archive = Path(temp) / "sdk.tar.gz"
        urllib.request.urlretrieve(URL, archive)
        with archive.open("rb") as stream:
            assert hashlib.file_digest(stream, "sha512").hexdigest() == SHA512, "SDK checksum mismatch"
        extracted = Path(temp) / "sdk"
        extracted.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(extracted, filter="data")
        target.parent.mkdir(parents=True, exist_ok=True)
        # Preserve existing SDK/runtime versions when adding the new SDK.
        if target.exists():
            shutil.copytree(extracted, target, dirs_exist_ok=True)
        else:
            shutil.move(str(extracted), str(target))
    print(f"Installed verified .NET SDK {VERSION} at {target}")
resolved = subprocess.check_output([str(target / "dotnet"), "--version"], cwd=Path(__file__).resolve().parents[1] / "agent", text=True).strip()
if resolved != VERSION:
    raise SystemExit("Installed SDK does not match agent/global.json")
print(f"Verified pinned SDK {resolved}")
