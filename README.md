# RayPay

## Workspace synchronization

Use the `scripts/sync_and_rebuild.sh` helper to reset the current checkout to the
latest `origin/main`, clean untracked build artifacts, and reinstall backend
dependencies.

```bash
./scripts/sync_and_rebuild.sh
```

The script assumes that the `origin` remote points to the GitHub repository.
