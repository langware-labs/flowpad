/**
 * The address slot's shell, shared by its two modes (the breadcrumb address and
 * the search omnibox that replaces it). One constant, so "same pill, same
 * height, same width" is a fact rather than two class strings that happen to
 * agree today.
 */
/* Padding is INLINE (`ps`/`pe`), not physical: the roomy side is the one the
 * trail starts on and the tight side is the one the search button sits on, and
 * which of those is left or right flips with the locale. */
export const ADDRESS_PILL_CLASS =
  'flex h-9 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-full border bg-background ps-3 pe-1.5 text-sm text-muted-foreground';
