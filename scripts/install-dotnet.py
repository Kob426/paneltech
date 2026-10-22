"""Optional Linux x64 .NET SDK, exact release with pinned official SHA-512."""
import hashlib
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

VERSION = "8.0.426"
URL = f"https://builds.dotnet.microsoft.com/dotnet/Sdk/{VERSION}/dotnet-sdk-{VERSION}-linux-x64.tar.gz"
SHA512 = "8141d01bdc53f604aed3bb661b604707a64209f8a947cd81bf95b4f518951593d77864069191f54ea5e84362a409da6b0f69074bf893b283d7e0cf93e2bf20a8"
target = Path(os.environ.get("PANELTECH_DOTNET_DIR", "/workspace/.tools/dotnet"))
if (target / "dotnet").exists():
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
        shutil.move(str(extracted), str(target))
    print(f"Installed verified .NET SDK {VERSION} at {target}")
