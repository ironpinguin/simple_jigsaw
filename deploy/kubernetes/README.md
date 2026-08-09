# Kubernetes example

An example, not a product: the app only. Postgres and the S3-compatible object
storage are expected to exist already — a managed database and bucket, or your
own charts. Point `DATABASE_URL` and the `S3_*` values at them.

```bash
cp secret.example.yaml secret.yaml   # fill in, keep out of git
kubectl apply -f configmap.yaml -f secret.yaml -f deployment.yaml -f service.yaml
```

## The probes

- **liveness → `/api/health`** answers as long as the process serves requests
  and touches no database. Pointing liveness at the readiness path instead
  would restart every pod whenever the database blips.
- **readiness → `/api/health/ready`** checks the database and answers `503`
  when it is unreachable, taking the pod out of the Service until it recovers.
- **startup → `/api/health`** covers `prisma db push`, which the container runs
  before starting the server.

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
