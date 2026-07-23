# SQL Runner — BI Publisher catalog objects

These are the catalog objects CloudConnect uses to execute arbitrary SQL against
an Oracle Fusion pod. Oracle Fusion SaaS does not expose the database on a
network port, so all query execution goes through Oracle Analytics Publisher
(BI Publisher), which is embedded in every pod.

| File | Type | Purpose |
| --- | --- | --- |
| `SQLRunner.xdm` | Data Model | A single dataset whose SQL is the lexical reference `&p_sql`. BI Publisher substitutes the `p_sql` parameter into the SQL text before parsing, so the caller controls the entire statement. |
| `SQLRunner.xdo` | Report | Bound to the data model above; default output format is CSV. |

## Automatic deployment (recommended)

In CloudConnect: **Account → Manage Connections → Deploy SQL Runner**. This
uploads both objects to `/Custom/CloudConnect/` via the BI Publisher SOAP
`CatalogService.uploadObject` operation. The connecting user needs the
`BIAuthor` role (or equivalent) to write to the catalog.

## Manual deployment

If you prefer to deploy by hand:

1. In Fusion, open **Tools → Reports and Analytics → Catalog**.
2. Create the folder `/Custom/CloudConnect`.
3. Upload `SQLRunner.xdm` as a Data Model and `SQLRunner.xdo` as a Report,
   or import them with the BI Publisher catalog import tooling.
4. Confirm the data model's data source matches your pod
   (`ApplicationDB_FSCM` for Financials/SCM, `ApplicationDB_HCM` for HCM).

## Security note

The SQL Runner executes whatever SQL the connected user submits, subject to the
database privileges of the Fusion schema the BI Publisher data source connects
as. Grant the CloudConnect integration user only the read access it needs, and
rely on Fusion's audit logging for statement-level accountability. This is a
reporting/read tool — do not grant it write access to transactional schemas.
