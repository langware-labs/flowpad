---
id: 83be67d5-7ec3-4e96-a19b-3d5b6892ad9c
title: Assistant funding states
---

# Assistant funding states

Every row in **Assistants & keys** (and the chip in the footer) carries one word. It answers one question: **what pays for this assistant's model calls?** When something does, the word names it. When nothing does, the word says why. "Signed in" is never shown on its own — a plan that pays implies the sign-in.

**Details ›** on any row opens the LLM sources page focused on that row, where every candidate source is listed with the reason it can or cannot pay.

## Plan

The assistant is signed in to its vendor and spends that subscription (Claude Max, ChatGPT, GitHub Copilot). Nothing is billed through FlowPad. The small text shows the account and plan the vendor reported.

If you sign out of the CLI in a terminal, the row drops to the next eligible source on its next check — or to **Signed out** if there is none.

## API key

A provider key stored on this machine (OpenRouter, Anthropic, OpenAI) pays. The key itself is never shown again; the row shows a masked hint such as `****ab12` so you can tell which key it is. Keys are managed in the **API keys** section of LLM sources.

A signed-out assistant that a key still pays for shows **API key**, with "signed out" in the small text: the key is what pays, the sign-out is only a caveat.

## LLM Endpoint

A hub endpoint your FlowPad account funds pays, and the pill shows what is left of its tightest cost cap (".58 left"). An endpoint is usually what pays when the assistant is signed out and no key is stored: the resolver falls through to it. The **Hub endpoints** section of LLM sources lists every endpoint the account can spend; the endpoint's own page on the hub shows its chain, limits and usage.

## Signed out

Nothing pays, and the missing piece is the assistant's own login. The button reads **Sign in** and opens the vendor's sign-in flow. A login that has never been checked reads **Not checked** instead — it is not presumed to be signed in.

## Not installed

The assistant's CLI is not on this machine, so nothing can pay for it. **Sign in** opens the dialog that offers to install it.

## Default assistant

The assistant FlowPad launches when nothing names one. Tick a row to make it the default. The startup check asks whether the default is funded; if it is not, Assistants & keys opens by itself.

## API keys

One slot per provider. "1 of 3 set" means one provider has a key stored. Open the section to add, test or delete a key.

## Hub endpoints

The endpoints your FlowPad account can spend, how many are in use, and the tightest amount left among those. Open the section for the full list with a budget bar per endpoint.
