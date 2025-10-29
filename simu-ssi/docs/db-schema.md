# Database Schema Overview

The Prisma schema is defined in `apps/server/prisma/schema.prisma` and mirrors the specification:

- `SiteConfig` maintains global configuration including evacuation delay and process acknowledgement requirement.
- `ProcessAck` stores acknowledgement status and audit trail.
- `ManualCallPoint` records manual call point state and timestamps per zone.
- `Zone`, `Device`, and `Scenario` provide topology and training data.
- `Session`, `EventLog`, and `Score` track runtime activity, logging, and assessment outputs.
