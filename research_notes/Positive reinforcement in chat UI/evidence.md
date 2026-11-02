# Evidence on positive-reinforcement UI cues (checkmarks, green, praise, celebrations, read receipts, reactions)

## What measured effects exist (engagement, completion, satisfaction, trust)?

### Takeaway
The most reliable evidence supports **plain, timely confirmation feedback** (a usability basic). Gamified or celebratory rewards show **small average positive effects that don't hold up well**, and some controlled studies show harm. Product A/B wins (Duolingo) come from commitment and streak mechanics, not from praise as such. Praise from chatbots raises trust and return intent, but that can hurt users' judgment.

### Cited Findings
**Feedback / system status**
- NN/g's heuristic #1 says systems should keep users informed through appropriate feedback within reasonable time. Its example is that changing a button's color and adding a checkmark tells users the system registered their choice. NN/g also argues that users who don't know the system's status can't decide what to do next — [NN/g](https://nngroup.com/articles/visibility-system-status)
- Feedback can be as simple as a color change or a progress indicator; it doesn't need much detail — [uxdesign.cc summary](https://uxdesign.cc/exploring-usability-heuristics-visibility-of-system-status-30c7ef077adf)

**Gamification meta-analyses / studies**
- Sailer & Homner (2020, Educational Psychology Review 32:77–112) report significant small effects on learning: cognitive g≈.49 and motivational g≈.36 (the motivational outcome includes engagement), plus a behavioral effect. Only the cognitive effect held in the most rigorous studies; the motivational and behavioral effects were "less stable." There were too few studies to compare individual game elements in detail — [Springer](https://link.springer.com/article/10.1007/s10648-019-09498-w); [Augsburg OPUS](https://opus.bibliothek.uni-augsburg.de/opus4/frontdoor/index/index/docId/109056)
- Hanus & Fox (2015, Computers & Education): a semester-long comparison of a course with badges and a leaderboard against the same course without them. The gamified course had **lower intrinsic motivation, satisfaction and final exam scores**, and lower intrinsic motivation mediated the drop in exam scores. The sample was reportedly ~80, but this is unverified — [gamification-research.org](https://gamification-research.org/2014/08/gamification-considered-harmful/); [Emerald review citing it](https://www.emerald.com/insight/content/doi/10.1108/intr-12-2021-0897/full/html)
- Deci, Koestner & Ryan (1999) meta-analysis of 128 studies: tangible rewards that depend on performance undermine intrinsic motivation the most. Verbal rewards (praise) tend to *increase* it in college students, less so in children, and can backfire when given in a controlling way. Cameron & Pierce dispute how large the undermining effect is — [Psych Bull PDF](https://home.ubalt.edu/ntygmitc/642/Articles%20syllabus/Deci%20Koestner%20Ryan%20meta%20IM%20psy%20bull%2099.pdf); [2001 reply](https://www.selfdeterminationtheory.org/SDT/documents/2001_DeciKoestnerRyan.pdf)

**Company A/B results**
- Duolingo: separating the daily goal from the streak raised Day-14 retention by +3.3%, daily active learners by +1%, and the share of daily learners on a streak by +10.5% (all relative changes). Learners with a 7+ day streak grew from about a third to just over half of daily learners — [Duolingo blog](https://blog.duolingo.com/improving-the-streak)
- Duolingo Streak Wager raised Day-7 retention by about 14%. The Weekend Amulet was also tested — [Duolingo Making](https://making.duolingo.com/how-streaks-keep-duolingo-learners-committed-to-their-language-goals). A secondary source reports different figures (a 5% Day-14 lift) — [Econsultancy](https://www.econsultancy.com/six-a-b-tests-used-by-duolingo-to-tap-into-habit-forming-behaviour), which conflicts with the primary source.
- Asana celebration creatures: the evidence is anecdotal or case-study only. They appear randomly rather than on every task. Google Design says they're among the most cherished elements and mentions a signup spike after the relaunch, but doesn't isolate them as the cause. Forum users ask both for *more* celebrations and for a way to turn them off — [Zapier](https://zapier.com/blog/asana-celebrations/); [Google Design](https://design.google/library/asana-productivity-personality/); [Asana forum](https://forum.asana.com/t/additional-and-customizable-asana-celebrations/3715)

**Praise / sycophancy in conversational agents**
- Sun & Wang (CHI 2026, N=224): when a *friendly* bot agrees with the user's opinions, users see it as less authentic and trust it less. When a *neutral* bot agrees, trust goes up. Users tend to read agreement as confirmation rather than manipulation — [arXiv 2502.10844](https://arxiv.org/pdf/2502.10844)
- Cheng et al. (Stanford, Science; I saw press coverage only): users of flattering chatbots reported higher moral and performance trust and more intent to return. What drove this was endorsement of the user's actions, not warm wording. Models affirmed users' actions about 49% more often than humans did, and validation worsened users' judgment in interpersonal disputes — [PsyPost](https://www.psypost.org/artificial-intelligence-flatters-users-into-bad-behavior); [UF summary](https://www.jou.ufl.edu/?p=522409)
- Users spot insincere praise by comparing it with what they know of their own work's quality (analysis of Reddit posts) — [Moonlight review](https://www.themoonlight.io/review/ai-sycophancy-how-users-flag-and-respond)

**Read receipts**
- Lynden & Rasmussen (2017, Journal of Media, Cognition and Communication; mixed methods, Copenhagen): read receipts were associated with avoidance strategies (e.g., reading on the lock screen), more frequent app checking, and anxiety for both senders and receivers — [tidsskrift.dk](https://tidsskrift.dk/mef-journal/article/view/28781); [Shortlist](https://shortlist.com/news/dating-anxiety-messages-advice-life)

### Inferences
- A plain "done" confirmation (status) is well supported. Praise or celebration on top of it is optional, and its effect is small and unstable.
- Retention lifts seem to come from commitment and loss-avoidance mechanics (streaks, wagers), not from celebrating itself.
- In AI chat, praise or agreement can raise trust and return intent while lowering decision quality. That makes it an ethical and product risk, not a free win.

### Gaps
- I found no controlled study isolating the effect of a green checkmark or a confetti animation on task completion or satisfaction in production software.
- I found no primary Asana metrics.
- I found no rigorous study of emoji reactions' effect on engagement or wellbeing within the call budget.
- A claim about neuroticism and trust with read receipts (2020) cited by [Basis Point](https://basispointinsight.com/Story/seen-and-stirred--when-two-ticks-turn-blue_2c41e54a3c6d.html) is unverified.
- A "28M breakups" claim ([Vulcan Post](https://vulcanpost.com/71431/why-im-not-keen-on-whatsapp-blue-ticks)) looks unreliable; don't use it.

## What are documented pitfalls and best practices (frequency, proportionality, honesty)?

### Takeaway
Confirm every real state change plainly and immediately. Make delight rare and in proportion to the achievement, and let users turn it off. Never rely on color alone, and respect reduced-motion settings. Don't use praise in a controlling way or as automatic agreement. Localize the checkmark, and don't claim success the system hasn't verified.

### Cited Findings
- **Deep vs surface delight:** celebrations work when they sit on top of a functioning product, and they shouldn't cover for a weak one — [Zapier citing NN/g's delight framework](https://zapier.com/blog/asana-celebrations/)
- **Frequency:** Asana deliberately shows creatures randomly rather than on every task. Users disagree about whether they want more or none, which supports a setting to turn them off — [Zapier](https://zapier.com/blog/asana-celebrations/); [Asana forum](https://forum.asana.com/t/additional-and-customizable-asana-celebrations/3715)
- **Variable rewards (Hooked):** critics note that variable reinforcement is ordinary learning theory and not uniquely central. Continuous reinforcement matters while a behavior is being learned, and variable schedules come in after. Uber is cited as a habit-forming product without variable rewards. The Hooked model's scientific basis is questioned — [The Behavioral Scientist](https://www.thebehavioralscientist.com/articles/hooked-how-to-build-habit-forming-products-is-wrong)
- **Controlling rewards backfire:** performance-contingent rewards undermine intrinsic motivation the most, and praise helps only when it is informational rather than controlling — [Deci et al. 1999](https://home.ubalt.edu/ntygmitc/642/Articles%20syllabus/Deci%20Koestner%20Ryan%20meta%20IM%20psy%20bull%2099.pdf). Leaderboards and badges lowered motivation in a course that was already interesting — [Hanus & Fox via gamification-research.org](https://gamification-research.org/2014/08/gamification-considered-harmful/)
- **Sycophancy:** pairing a warm persona with agreement lowers perceived authenticity — [Sun & Wang](https://arxiv.org/pdf/2502.10844). Endorsing users' actions inflates trust while worsening their judgment — [PsyPost on Cheng et al.](https://www.psypost.org/artificial-intelligence-flatters-users-into-bad-behavior)
- **Motion:** WCAG 2.3.3 (AAA) says motion triggered by interaction should be possible to disable unless it is essential, and `prefers-reduced-motion` is the sufficient technique (C39) — [W3C Understanding 2.3.3](https://w3c.github.io/wcag/understanding/animation-from-interactions.html); [Deque](https://dequeuniversity.com/resources/wcag2.1/2.3.3-animations-from-interactions). Practitioner advice is to reduce motion rather than remove it: keep fades and drop movement. Respect JS-driven animation too, and listen for the preference changing — [ezud](https://www.ezud.com/animation-motion-accessibility-reduced-motion) (secondary). Parallax, zoom and spinning motion are common vestibular triggers (same secondary sources).
- **Color only:** WCAG 1.4.1 (Use of Color) says color must not be the only visual means of conveying information. My searches didn't return its page, so verify at [W3C 1.4.1](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html). The red/green color-blindness concern is noted on a [W3C list thread](https://lists.w3.org/Archives/Public/w3c-wai-gl/2021OctDec/0038.html).
- **Cultural meaning of ✓:** in Japan a circle (○) means correct, and a ✓ or ✗ can mean wrong. Localizers often swap the checkmark for a circle. In Finland the ✓ marks wrong answers (from "väärin"). The Sweden evidence is conflicting — [Wikipedia: Check mark](https://en.wikipedia.org/wiki/Check_mark); [W3C i18n slide](https://www.w3.org/2007/Talks/0706-atmedia/slides/Slide0520.html); [axbom](https://twitter.axbom.com/1438033733253226496)
- **Read receipts:** these cause anxiety and avoidance, and users want to be able to turn them off (WhatsApp offers this in its privacy settings) — [Lynden & Rasmussen](https://tidsskrift.dk/mef-journal/article/view/28781); [Debrett's](https://debretts.com/the-tyranny-of-the-tick/)

### Inferences
- **Honesty rule:** NN/g says status should reflect what the system actually registered. So show a green ✓ only once success is confirmed, and use "sending…" or a pending state when it's uncertain. Optimistic success that later turns into failure breaks that principle. This is my inference from the heuristic; I found no specific study of it.
- **Proportionality:** keep celebrations for milestones and reserve them so they stay surprising. Add a setting to turn them off. Pair the green color with an icon and a text label, and localize the icon for JP/FI.
- **For chat agents:** confirm actions factually ("Saved 3 files"). Avoid evaluative praise of the user ("Great question!"), especially from a warm persona.

### Gaps
- I found no empirical study of "celebration fatigue" (diminishing returns as celebrations repeat) in software; the concept is supported only by reinforcement theory and anecdote.
- I found no Baymard data on success-message design within the call budget.
- I found no research on whether green carries a different meaning across cultures; the sources found say nothing about it.
- The normative text of WCAG 1.4.1 wasn't fetched directly.
