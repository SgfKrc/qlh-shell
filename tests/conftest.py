"""Test defaults for the standalone shell repository."""

import os
import sys
from pathlib import Path


SHELL_ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = Path(os.environ.get("QLH_CORE_ROOT", SHELL_ROOT.parent / "qlh")).resolve()
os.environ.setdefault("QLH_CORE_ROOT", str(CORE_ROOT))
os.environ.setdefault("QLH_SHELL_ROOT", str(SHELL_ROOT))

for path in (SHELL_ROOT / "scripts", CORE_ROOT / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
