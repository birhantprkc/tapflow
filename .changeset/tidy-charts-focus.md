---
'@tapflowio/relay': patch
---

**The resource charts no longer reserve space for time that has not happened.** The window's right edge was rounded up to the next round tick so the tick labels would stay on clean times, which left up to a full step of axis that no sample can ever reach — an hour of empty chart on the 6h range, and 63 pixels of 504 on 7d. Empty because it is in the future, which reads as a gap in the data rather than as the edge of the window. The window now ends at the moment of the reading and the ticks are counted down from the last round step at or before it, so the labels stay round and the newest sample sits at the right edge.

**The device viewer no longer draws a focus ring while you type at the phone.** The ring is scoped to `:focus-visible`, which the browser re-evaluates on every keystroke — and the viewer forwards keystrokes to the device from a listener on the window, so a tester who clicked the simulator and then typed had a ring appear around the whole viewer mid-sentence, under a focus a pointer had placed. None of those keys moved focus; they were going to the phone. The ring now reports how focus arrived: it is drawn unless a press just placed it, so a tap still shows nothing while `Tab`, a restart handing focus back, and anything else that moves the caret all show where it went.
