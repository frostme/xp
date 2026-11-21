# Statsig experiment workflow

**Auditor 3 · Statsig research agent · 21 November 2026**

Question investigated: How can an operator tell who owns a change, which actions apply now, and what a decision will serve? The observations below come from public Statsig Cloud console guides, their examples, and their screen references. The audit did not use an authenticated project. It establishes the documented paths and outcomes. It leaves keyboard behavior and live permission handling unverified.

## Documented operator journey

| Task                 | Entry, outcome and safeguard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discover and inspect | Open **Experimentation → Experiments**, then the experiment. Setup contains allocation and groups. Across tabs a details panel carries owner, team and status. The header opens committed change history. An operator can look up who owns the definition while inspecting it and distinguish a committed change from an idea under discussion. [Create, user-level experiments][create] · [Manage, experiment actions and detail tabs][manage]                                                                                                                    |
| Create and start     | **Create** opens a form that generates the ID from the name. The operator chooses a target application before Create becomes available. Creation opens an unstarted experiment. The operator configures group parameters and traffic, verifies behavior, then uses **Start**. Creating the record and exposing users are distinct steps. [Create, user-level experiments and configuration][create]                                                                                                                                                                |
| Change allocation    | Setup offers two different percentages. The operator can change how much eligible traffic enters a running experiment. Within an experiment, adding a group during setup redistributes the split, and the split locks at start. The documentation explains that resetting to change the group structure starts a new analysis window with new assignments. [Allocation][allocation] · [Groups, changes after start][groups]                                                                                                                                        |
| Stop or finish       | The ending guide compares each action's effect on newcomers, existing users and results. **Stop Assignments** stops enrollment. Existing users need persistent assignment to keep their experience. From **Make Decision** the operator can ship control or a treatment. In an untargeted experiment the chosen values become defaults for everyone. The documented example shows the layer default before the decision and after shipping either variant. [Ending, action comparison][ending] · [Make a Decision, experiments without a targeting gate][decision] |
| Interpret counts     | The Results example gives a date and group for each cumulative exposure total. An operator can compare recorded exposure volume across groups up to a date. The display does not establish how many current membership rows would survive a leave, a rejoin or a decision to ship. [Results, cumulative exposures][results]                                                                                                                                                                                                                                        |

## Four patterns and one weakness

1. Keep status and ownership within reach when switching tasks. The detail panel supplies that context on every tab. [Manage][manage]
2. Give creation and first delivery distinct actions. A saved definition can be inspected before any ramp begins. [Create][create]
3. Label the population affected by every percentage. Statsig distinguishes experiment entry from variant split and specifies which is still editable. [Allocation][allocation] · [Groups][groups]
4. Explain a consequential decision for two audiences. The ending guide's new-user and existing-user columns expose a difference that the verb “stop” alone cannot communicate. [Ending][ending]

**Weakness inferred for an operator.** A reader can understand the saved 100% rollout and still misidentify its lifecycle. Statsig documents that even a rollout reaching 100% can require a separate ship decision. Deducing finality from the number would give the wrong answer. [Make a Decision, resizing logic][decision]

## Two transfers to xp

- Put **Serving now** beside the saved phase in detail. In the directory, an awaiting-launch off pin and a finalized off winner should name different phases even though both currently return the application default. Availability, phase and winner come from xp storage. Host access supplies the viewer or manager role. A revision identifies the definition used for a proposed edit.
- Put the consequence for new and existing users directly in command review. For a reweight from 90/5/5 to 0/100/0, new users go to the second cohort and existing members keep their stored assignment. Choosing that cohort as winner also changes what existing members receive. Both reviews can show the same **Current memberships** table. Its counts describe stored rows as of the read, including any zero row, independently of the proposed change.

**Outside v1.** A metric-lift scorecard with confidence intervals requires metric and exposure data. A storage read can establish membership counts only. [Results, scorecards][results]

[create]: https://docs.statsig.com/experiments/create-new
[manage]: https://docs.statsig.com/experiments/manage
[allocation]: https://docs.statsig.com/experiments/setup/allocation-and-targeting
[groups]: https://docs.statsig.com/experiments/setup/groups-and-parameters
[ending]: https://docs.statsig.com/experiments/ending/ending-experiment
[decision]: https://docs.statsig.com/experiments/ending/make-decision
[results]: https://docs.statsig.com/experiments/interpreting-results/read-results
