import unittest

import mosaic_repository as repository


class RepositoryIdentityTests(unittest.TestCase):
    def test_only_exact_current_mosaic_name_is_accepted(self):
        self.assertEqual(
            "constbogdan/Mosaic",
            repository.authenticate_downstream_repository("constbogdan/Mosaic"),
        )

    def test_lookalikes_forks_case_variants_and_malformed_values_are_rejected(self):
        for value in (
            "constbogdan/Mosaic2",
            "other/Mosaic",
            "constbogdan/Wholphin",
            "constbogdan/mosaic",
            "constbogdan/wholphin",
            "fork/Wholphin",
            "constbogdan",
            "",
            None,
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    repository.authenticate_downstream_repository(value)

    def test_workflow_ref_is_bound_to_mosaic(self):
        workflow = ".github/workflows/ci.yml"
        env = {
            "GITHUB_REPOSITORY": "constbogdan/Mosaic",
            "GITHUB_WORKFLOW_REF": f"constbogdan/Mosaic/{workflow}@refs/heads/main",
        }
        self.assertEqual(
            "constbogdan/Mosaic",
            repository.authenticate_workflow_repository(env, workflow),
        )
        env["GITHUB_WORKFLOW_REF"] = f"constbogdan/Wholphin/{workflow}@refs/heads/main"
        with self.assertRaises(ValueError):
            repository.authenticate_workflow_repository(env, workflow)


if __name__ == "__main__":
    unittest.main()
