# Kubernetes example

An example, not a product: the app only. Postgres and the S3-compatible object
storage are expected to exist already — a managed database and bucket, or your
own charts. Point `DATABASE_URL` and the `S3_*` values at them.

```bash
cp secret.example.yaml secret.yaml   # fill in, keep out of git
kubectl apply -f configmap.yaml -f secret.yaml -f deployment.yaml -f service.yaml
```

`configmap.yaml` ships `ADMIN_EMAILS` empty; leave it that way and bootstrap the
first admin with `kubectl exec deploy/jigsaw -- npm run make-admin -- you@example.org`
instead, if you would rather not put an address in the configmap.

## The probes

- **liveness → `/api/health`** answers as long as the process serves requests
  and touches no database. Pointing liveness at the readiness path instead
  would restart every pod whenever the database blips.
- **readiness → `/api/health/ready`** checks the database and answers `503`
  when it is unreachable, taking the pod out of the Service until it recovers.
- **startup → `/api/health`** covers `prisma db push`, which the container runs
  before starting the server.

## The database has to be up when a pod starts

The container's command is `npm run db:push && exec npx next start`: it migrates
before it serves. If the database is unreachable at that moment the process
exits and the pod goes `CrashLoopBackOff`. No probe changes that, and the
`startupProbe`'s budget never comes into it, because nothing is listening yet.

This is worth knowing precisely because it looks like a probe problem and is
not. A pod that was already running rides an outage out — liveness stays green,
readiness turns `503`, the pod leaves the Service and rejoins it when the
database returns, without ever restarting. A pod that has to *start* during the
same outage cannot, and will keep restarting until the database is back. So a
rollout begun while the database is down will not complete, even though the
pods it is replacing were serving happily a moment earlier.

## Legal pages

`configmap.yaml` ships `LEGAL_NAME`, `LEGAL_ADDRESS` and `LEGAL_EMAIL` empty, so
a deployment can look healthy — both probes green — while `/legal/imprint`
names the missing variables and `/legal/privacy` says no controller is
configured. All three are required before the instance is publicly reachable;
see `.env.example` for what each one says on the page.

## Retention and replicas

Expired confirmation and invitation links are deleted at startup, hourly, and
on readiness checks (GDPR Art. 5(1)(e)). The interval is tracked per process,
so `replicas: N` means up to N sweeps an hour instead of one. That is a
`DELETE` against a table this sweep keeps small — harmless, but worth knowing
before you read the query log.

If you would rather have exactly one sweep, run the script on a schedule and
ignore that the pods also do it:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: jigsaw-purge-expired
spec:
  schedule: "0 4 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: purge
              image: ghcr.io/ironpinguin/simple_jigsaw:latest
              command: ["npm", "run", "purge-expired"]
              envFrom:
                - secretRef: { name: jigsaw-secrets }
```
