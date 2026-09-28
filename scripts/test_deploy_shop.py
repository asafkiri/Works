import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('deploy', pathlib.Path(__file__).with_name('deploy-shop.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class LegacyMigration(unittest.TestCase):
    def setUp(self):
        self.source = '\n'.join('exports.' + n + ' = handler;' for n in deploy.HANDLERS)
        self.source += '\nfor (const occ of occs) { sendAttendance(); }\nsendLongShift();\nsendScheduleChanges();\n'

    def test_only_attendance_loop_changes_and_patch_is_idempotent(self):
        patched = deploy.patch_legacy(self.source)
        self.assertIn('shopOnly ? [] : occs', patched)
        self.assertIn('sendLongShift();\nsendScheduleChanges();', patched)
        self.assertEqual(deploy.patch_legacy(patched), patched)
        without_patch = patched.replace(deploy.APPEND, '')
        start = without_patch.index(deploy.MARKER)
        end = without_patch.index(' {', start) + 2
        restored = without_patch[:start] + 'for (const occ of occs) {' + without_patch[end:]
        self.assertEqual(restored, self.source)

    def test_unrecognized_or_ambiguous_source_stops(self):
        for source in [self.source.replace('exports.notifyTaking', 'exports.other'),
                       self.source.replace('for (const occ of occs)', 'for (const x of items)'),
                       self.source + 'for (const occ of occs) { }']:
            with self.assertRaises(ValueError):
                deploy.patch_legacy(source)


if __name__ == '__main__':
    unittest.main()
