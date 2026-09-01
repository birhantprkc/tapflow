---
'@tapflowio/relay': patch
---

The record button keeps keyboard focus while a recording is processed and saved, and announces both outcomes to assistive technology. It used `disabled` for those states, which took the focused button out of the tab order the moment "Stop recording" was activated, so focus fell to the page body and the name that changed to say what happened was read to nobody. It now stays focusable, refuses a click on its own while busy, and carries the outcome in a live region beside it.
