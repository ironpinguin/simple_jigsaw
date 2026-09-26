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
- **startup → `/api/health`** gives the container time to finish
  `npm run db:push` before the other two probes start counting failures.

## The database has to be up when a pod starts

The container's command is `npm run db:push && exec npx next start`: it migrates
before it serves. If the database is unreachable at that moment the process
exits and the pod goes `CrashLoopBackOff`. No probe changes that: the kubelet
restarts an exited container whatever the probes say. The `startupProbe`'s
budget only ever covers a server that is still starting, never one that has
already given up, so raising `failureThreshold` will not help here.

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

`LEGAL_MAIL_PROCESSOR` and `LEGAL_STORAGE_PROCESSOR` are the ones that bite
quietly. This example points `SMTP_HOST` and `S3_ENDPOINT` at services outside
the cluster, and an external service with an empty value here makes the privacy
policy state that mail and image storage are *self-hosted* — a false statement
rather than a missing one, and the processor naming Art. 28 asks for. Fill both
in, or point the two services back inside the cluster. `LEGAL_HOSTING_REGION`
is optional but empty means the policy declines to state a location.

## Security context

`deployment.yaml` drops capabilities and forbids privilege escalation, but not
`runAsNonRoot`: the image has no `USER`, so the container runs as root and that
setting would stop the pod starting. If you add `USER node` to the Dockerfile's
`runner` stage, add `runAsNonRoot: true` and `runAsUser: 1000` here to match.

## Retention and replicas

Expired confirmation and invitation links are deleted at startup and hourly
after that (GDPR Art. 5(1)(e)); a readiness check can bring the next sweep
forward, but never past the hourly budget. That budget is tracked per process,
so `replicas: N` means up to N sweeps an hour instead of one. That is a
`DELETE` against a table this sweep keeps small — harmless, but worth knowing
before you read the query log.

`/api/health/ready` reports `"retention": "stale"` once several hours pass with
no sweep succeeding, and stays `200` while it does — a pod whose housekeeping is
stuck still serves traffic. It is worth alerting on: `SELECT 1` passing says
nothing about whether the `DELETE` does, and a role without delete rights or a
full disk leaves readiness green while expired data accumulates.

There is no way to switch the in-process sweep off, so a `CronJob` is an
addition to it, not a replacement. It is still worth having if you want the
deletion to run against a database the pods are not attached to, or on a
schedule you control and can audit:

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
              # DATABASE_URL from the secret and DATABASE_PROVIDER from the
              # configmap: the image carries a client for both databases and
              # the script picks one the way the app does.
              envFrom:
                - configMapRef: { name: jigsaw-config }
                - secretRef: { name: jigsaw-secrets }
```
