import unittest

import seerr_repository as repository


class RepositoryIdentityTests(unittest.TestCase):
    def test_only_exact_current_seerr_name_is_accepted(self):
        self.assertEqual(
            "constbogdan/seerr",
            repository.authenticate_downstream_repository("constbogdan/seerr"),
        )
        self.assertEqual("constbogdan/seerr", repository.SEERR_DOWNSTREAM_REPOSITORY)
        self.assertEqual("seerr-team/seerr", repository.UPSTREAM_REPOSITORY)
        self.assertEqual("downstream-main", repository.PROTECTED_BRANCH)

    def test_lookalikes_forks_case_variants_and_malformed_values_are_rejected(self):
        for value in (
            "constbogdan/seerr2",
            "other/seerr",
            "seerr-team/seerr",
            "constbogdan/Seerr",
            "constbogdan/SEERR",
            "fork/seerr",
            "constbogdan",
            "",
            None,
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    repository.authenticate_downstream_repository(value)

    def test_workflow_ref_is_bound_to_seerr_and_downstream_main(self):
        workflow = ".github/workflows/downstream-validation.yml"
        env = {
            "GITHUB_REPOSITORY": "constbogdan/seerr",
            "GITHUB_WORKFLOW_REF": (
                f"constbogdan/seerr/{workflow}@refs/heads/downstream-main"
            ),
        }
        self.assertEqual(
            "constbogdan/seerr",
            repository.authenticate_workflow_repository(env, workflow),
        )
        for workflow_ref in (
            f"constbogdan/seerr/{workflow}@refs/heads/develop",
            f"constbogdan/seerr/{workflow}@refs/heads/main",
            f"seerr-team/seerr/{workflow}@refs/heads/downstream-main",
            f"constbogdan/Seerr/{workflow}@refs/heads/downstream-main",
            "",
            None,
        ):
            with self.subTest(workflow_ref=workflow_ref):
                env["GITHUB_WORKFLOW_REF"] = workflow_ref
                with self.assertRaises(ValueError):
                    repository.authenticate_workflow_repository(env, workflow)


if __name__ == "__main__":
    unittest.main()
