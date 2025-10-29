# State Diagrams Overview

This document provides state-diagram level documentation for the safety system simulator.

- **SDI** implements idle, pre-alarm, and cleared states.
- **DM** transitions between `Cleared` and `Latched`.
- **CMSI** orchestrates evacuation sequencing with `EvacPending`, `EvacActive`, `EvacSuspended`, and `SafeHold`.
- **UGA** mirrors CMSI evacuation states.
- **DAS** applies and releases actuations in sync with evacuation status.
- **Alims** covers mains/battery transitions with failure detection hooks.

Each machine is encoded with XState in `packages/domain-ssi`.
