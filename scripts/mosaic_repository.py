"""Exact current downstream and upstream repository identities."""

SEERR_DOWNSTREAM_REPOSITORY = "constbogdan/seerr"
# Temporary compatibility for copied maintenance layers that are adapted later.
MOSAIC_DOWNSTREAM_REPOSITORY = SEERR_DOWNSTREAM_REPOSITORY
UPSTREAM_REPOSITORY = "seerr-team/seerr"
PROTECTED_BRANCH = "downstream-main"


def authenticate_downstream_repository(value):
    """Return a trusted exact downstream identity or fail closed."""
    if value != SEERR_DOWNSTREAM_REPOSITORY:
        raise ValueError(
            "Untrusted downstream repository; expected exactly "
            + SEERR_DOWNSTREAM_REPOSITORY
        )
    return value


def authenticate_workflow_repository(env, workflow):
    """Authenticate the runtime repository and its exact protected workflow ref."""
    repository = authenticate_downstream_repository(env.get("GITHUB_REPOSITORY"))
    expected = f"{repository}/{workflow}@refs/heads/{PROTECTED_BRANCH}"
    if env.get("GITHUB_WORKFLOW_REF") != expected:
        raise ValueError("Workflow ref does not belong to the authenticated downstream repository")
    return repository


def repository_url(repository):
    return "https://github.com/" + authenticate_downstream_repository(repository)
