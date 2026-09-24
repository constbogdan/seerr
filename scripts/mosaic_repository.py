"""Exact current downstream and upstream repository identities."""

MOSAIC_DOWNSTREAM_REPOSITORY = "constbogdan/Mosaic"
UPSTREAM_REPOSITORY = "damontecres/Wholphin"


def authenticate_downstream_repository(value):
    """Return a trusted exact downstream identity or fail closed."""
    if value != MOSAIC_DOWNSTREAM_REPOSITORY:
        raise ValueError(
            "Untrusted downstream repository; expected exactly "
            + MOSAIC_DOWNSTREAM_REPOSITORY
        )
    return value


def authenticate_workflow_repository(env, workflow):
    """Authenticate the runtime repository and its exact protected-main workflow ref."""
    repository = authenticate_downstream_repository(env.get("GITHUB_REPOSITORY"))
    expected = f"{repository}/{workflow}@refs/heads/main"
    if env.get("GITHUB_WORKFLOW_REF") != expected:
        raise ValueError("Workflow ref does not belong to the authenticated downstream repository")
    return repository


def repository_url(repository):
    return "https://github.com/" + authenticate_downstream_repository(repository)
