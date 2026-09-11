---
'@tapflowio/relay': patch
---

Pressing the upper half of an iPhone's Volume Up pressed the **Action** button instead. The tooltip said Action and the press followed it, so a tester reaching for volume changed a setting they never opened.

A button's catchment was a fixed radius around its *centre*, and the first button in range won rather than the nearest — so on an iPhone 15 Pro, where the Action button sits close above a much taller Volume Up, Action's circle covered Volume Up's own pixels and claimed them because the agent happens to list it first. Catchment is now measured to each button's rectangle, the nearest one wins, and a press inside a button can no longer lose to a neighbour. Targets are as generous as before: the same margin now surrounds the button instead of radiating from its middle.
