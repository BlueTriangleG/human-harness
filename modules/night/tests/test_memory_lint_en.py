#!/usr/bin/python3
"""memory_lint's language rules for an English role: the atoms, hedges, pronouns and speakers it finds in English."""
import os
import unittest

os.environ["HH_LANG"] = "en"          # before the scripts load their forms
os.environ["HH_ME"] = "Aqing"
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
import memory_lint as L  # noqa: E402


def atoms(line):
    return {(k, key) for k, key, _ in L.extract(line)}


class English(unittest.TestCase):
    def test_atoms(self):
        a = atoms('On Nov 3 at 14:05 we spent $25 and watched episode 3 for 2 hours; she said "see you at the lake"')
        for want in (('date', '11-03'), ('time', '14:05'), ('num', '25$'), ('num', 'episode3'), ('num', '2hour')):
            self.assertIn(want, a)
        self.assertTrue(any(k == 'quote' for k, _ in a))
        self.assertEqual(atoms('3 hours later'), atoms('3 hour later'))      # singular and plural are one key

    def test_labels_and_windows_are_not_facts(self):
        self.assertEqual(atoms('Week 3 (11-02 – 11-08): a 7-day window'), set())
        self.assertEqual(atoms('the button called "Save now"'), set())

    def test_hedges(self):
        self.assertTrue(L.hedged('maybe it was Tuesday'))
        self.assertFalse(L.hedged('it was Tuesday'))
        self.assertFalse(L.hedged('she wrote "maybe later" on the card'))   # inside a quote it is what someone said

    def test_pronouns_on_word_boundaries(self):
        text = 'She said he would come; then the theme changed and they left.'
        self.assertEqual((L.pron_count(text, 'he'), L.pron_count(text, 'she')), (1, 1))

    def test_who_said_a_quote(self):
        lint = object.__new__(L.Lint)
        lint.names, lint.gender, lint._tokre = [('laolin', ['Laolin', 'Zhou'])], {'laolin': 'm'}, None
        lint.subject_of = lambda rel, title: None
        def who(line):
            return lint.attribute('memory/x.md', line, line.index('"'), len(line), '')
        self.assertEqual(who('Laolin said, "see you at nine"'), 'laolin')
        self.assertEqual(who('I told them "wait for me"'), None)     # told them: not a verb of saying to the role
        self.assertEqual(who('I said "wait for me"'), L.ME)
        self.assertIsNone(who('the theme said "x"'))                   # "he" inside "theme" is no pronoun

    def test_model_names_are_words_with_digits_or_inner_capitals(self):
        import re
        found = re.findall(L.form('lintNameTokens'), 'We bought an RTX4090 and an iPhone for the trip to Sydney')
        self.assertEqual(found, ['RTX4090', 'iPhone'])

    def test_speaker_labels(self):
        self.assertEqual(L.speaker_label('me', 'hi', []), L.ME)
        self.assertEqual(L.speaker_label('我', 'hi', []), L.ME)


if __name__ == '__main__':
    unittest.main()
