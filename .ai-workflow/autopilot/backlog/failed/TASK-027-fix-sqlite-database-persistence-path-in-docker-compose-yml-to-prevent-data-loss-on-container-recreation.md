# TASK-027

## Title
Fix SQLite database persistence path in docker-compose.yml to prevent data loss on container recreation

## Type
bug

## Priority
critical

## Autonomy
auto

## Evidence
[`docker-compose.yml:28,44,63,75`](file:///D:/E/Video_AI/docker-compose.yml#L28) and [`docker/api.Dockerfile:9`](file:///D:/E/Video_AI/docker/api.Dockerfile#L9): In `docker-compose.yml`, `api` and `worker` define `DATABASE_URL=file:./data.db` while `WORKDIR /app` is set in `docker/api.Dockerfile`. SQLite opens `/app/data.db`. However, the persistent named volume `db_data` is mounted to `/app/data`. Therefore, `/app/data.db` is stored on the ephemeral container filesystem and destroyed whenever the container is updated, rebuilt, or restarted.

## Affected Areas
- `docker-compose.yml`

## Expected Outcome
Update `DATABASE_URL` in `docker-compose.yml` for both `api` and `worker` to `file:./data/data.db` (or ensure the directory exists and points directly into the mounted volume `/app/data/data.db`), ensuring SQLite data persists across container lifecycles.

## Constraints
Ensure both `api` and `worker` point to the identical database file path within the mounted volume.

## Suggested Verification
`docker compose config`

## Status
PENDING
