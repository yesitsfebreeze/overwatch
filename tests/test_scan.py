"""Scan must see parameterised just recipes and let `verify` supersede raw cargo. Run: python3 tests/test_scan.py"""
import importlib.machinery, importlib.util, os, sys, tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
loader = importlib.machinery.SourceFileLoader("steward", str(root / "bin/steward"))
spec = importlib.util.spec_from_loader("steward", loader)
steward = importlib.util.module_from_spec(spec)
loader.exec_module(steward)

with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    Path("Cargo.toml").write_text("[package]\n")
    Path("justfile").write_text('target := "x"\nbuild:\n\tcargo build\ntest *args:\n\tcargo test\nverify rev="HEAD":\n\techo\n')
    got = steward.discover()
    assert got == ["just build", "just verify"], got
print("ok")
