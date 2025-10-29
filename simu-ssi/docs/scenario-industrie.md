# Industrial Scenario Notes

This guide summarises industrial rules embedded into the simulator:

- DAI are non-evacuating and always remain in pre-alarm state unless confirmed.
- Manual call points trigger a 5 minute timer before automatic evacuation unless suspended by process acknowledgement.
- Process acknowledgements must be given before T=0 to suspend evacuation.
- Manual evacuation is always available with logging and can be cancelled cleanly.
- Reset is blocked until all manual call points are cleared and the system is safe.
