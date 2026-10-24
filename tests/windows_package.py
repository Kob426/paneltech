"""Verifier regressions against an actual cross-published package. No Windows execution."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('packager',ROOT/'scripts/package-agent.py')
packager=importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
class PackageChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source=Path(os.environ['PANELTECH_WINDOWS_PACKAGE'])
        cls.valid=packager.verify(cls.source)
        with zipfile.ZipFile(cls.source) as z:cls.original={i.filename:z.read(i) for i in z.infolist()}
    def altered(self,change,rehash=False):
        temporary=tempfile.TemporaryDirectory(prefix='paneltech-package-test-');self.addCleanup(temporary.cleanup)
        entries=dict(self.original);change(entries)
        if rehash:
            manifest=json.loads(entries[packager.PREFIX+'manifest.json'])
            manifest['files']=[{'path':name[len(packager.PREFIX):],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()} for name,data in entries.items() if name!=packager.PREFIX+'manifest.json']
            entries[packager.PREFIX+'manifest.json']=json.dumps(manifest).encode()
        path=Path(temporary.name)/'altered.zip'
        with zipfile.ZipFile(path,'w') as z:
            for name,data in entries.items():z.writestr(name,data)
        return path
    def test_published_package_has_valid_inventory_and_x64_headers(self):
        self.assertTrue(self.valid['ok']);self.assertEqual(self.valid['target'],'win-x64');self.assertFalse(self.valid['windowsExecutionVerified']);self.assertGreater(self.valid['files'],20)
    def test_missing_qos_rejected(self):
        p=self.altered(lambda d:d.pop(packager.PREFIX+'qos.ps1'))
        with self.assertRaises(ValueError):packager.verify(p)
    def test_tampered_dll_rejected(self):
        p=self.altered(lambda d:d.update({packager.PREFIX+'PanelTech.Agent.dll':b'corrupt'}))
        with self.assertRaises(ValueError):packager.verify(p)
    def test_wrong_architecture_rejected_even_with_updated_hash(self):
        def change(d):
            key=packager.PREFIX+'PanelTech.Agent.exe';exe=bytearray(d[key]);offset=struct.unpack_from('<I',exe,0x3c)[0];struct.pack_into('<H',exe,offset+4,0x14c);d[key]=bytes(exe)
        with self.assertRaises(ValueError):packager.verify(self.altered(change,True))
    def test_wrong_framework_rejected_even_with_updated_hash(self):
        for version in ['8.0.0','10.0.0']:
            def change(d):
                key=packager.PREFIX+'PanelTech.Agent.runtimeconfig.json';r=json.loads(d[key]);r['runtimeOptions']['framework']['version']=version;d[key]=json.dumps(r).encode()
            with self.subTest(version=version),self.assertRaises(ValueError):packager.verify(self.altered(change,True))
    def test_missing_dependency_rejected_even_with_updated_hash(self):
        def change(d):
            key=packager.PREFIX+'PanelTech.Agent.deps.json';r=json.loads(d[key]);target=r['runtimeTarget']['name'];r['targets'][target]['PanelTech.Agent/1.0.0']['runtime']['Missing.dll']={};d[key]=json.dumps(r).encode()
        with self.assertRaises(ValueError):packager.verify(self.altered(change,True))
    def test_credentials_and_windows_unsafe_names_rejected(self):
        for name in ['identity.json','config.json','enrollment.txt','../outside.dll','CON.txt','AUX.dll','folder\\outside.dll','file.dll.']:
            with self.subTest(name=name),self.assertRaises(ValueError):
                packager.verify(self.altered(lambda d:d.update({packager.PREFIX+name:b'data'}),True))
    def test_case_duplicate_rejected(self):
        with self.assertRaises(ValueError):packager.verify(self.altered(lambda d:d.update({packager.PREFIX+'QOS.PS1':b'data'}),True))
    def test_qos_without_utf8_bom_rejected(self):
        def change(d):
            key=packager.PREFIX+'qos.ps1';d[key]=d[key].removeprefix(b'\xef\xbb\xbf')
        with self.assertRaises(ValueError):packager.verify(self.altered(change,True))
    def test_existing_output_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'existing.zip';target.write_bytes(b'keep')
            with self.assertRaises(ValueError):packager.build(target)
            self.assertEqual(target.read_bytes(),b'keep')
if __name__=='__main__':unittest.main()
