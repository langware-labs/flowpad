test 1: Selection toolbar appears above a non-empty text selection in editor mode
- navigate to {APP_URL}/dock/assets/list/markdown
- wait for the asset list to render
- click any markdown row to open it in the editor
- click the "Editor" button in the mode toggle group (the Pencil icon)
- wait for the ProseMirror editor (.ProseMirror) to be visible
- programmatically select the first 6 characters of the first paragraph or heading inside .ProseMirror
- wait 100 ms for the selectionUpdated listener to flush
- validate the element with data-testid="selection-toolbar" is visible
- validate the toolbar contains exactly 4 buttons with titles: "Bold", "Italic", "Inline code", and one of "Add link" / "Edit link"
- validate the toolbar's bounding rect top is above (smaller y) the selection rect (popup floats above the text)

test 2: Bold button in selection toolbar formats the selected text
- with a non-empty selection active and data-testid="selection-toolbar" visible
- dispatch a `mousedown` event on the button with title="Bold" inside the selection toolbar
- wait 150 ms
- validate the .ProseMirror DOM now contains a <strong> element whose textContent equals the previously selected substring
- validate the selection toolbar is still visible (selection has not collapsed yet)

test 3: Selection toolbar disappears when the selection collapses
- with the selection toolbar visible
- collapse the selection (call window.getSelection().collapseToEnd() or press ArrowRight)
- wait 100 ms for the selectionUpdated listener
- validate data-testid="selection-toolbar" is no longer present in the DOM

test 4: Selection toolbar is hidden in view and review modes
- open a markdown doc in the editor
- click the "View" button (Eye icon) in the mode toggle
- wait for read-only mode to take effect (toolbar bar above the editor disappears)
- programmatically select 6 characters in the rendered content
- wait 200 ms
- validate data-testid="selection-toolbar" is NOT present
- click the "Review" button (MessageSquareDiff icon)
- repeat the selection
- validate data-testid="selection-toolbar" is NOT present

test 5: Selection toolbar is suppressed while the LinkPopup is open
- open a markdown doc in editor mode
- select 6 characters of plain text inside .ProseMirror
- wait for data-testid="selection-toolbar" to be visible
- dispatch `mousedown` on the button with data-testid="milkdown-toolbar-link" inside the selection toolbar
- wait for data-testid="milkdown-link-popup" with data-mode="new" to appear
- validate data-testid="selection-toolbar" is NOT present (only the link popup is shown)
- press Escape to close the link popup
- wait 100 ms
- validate data-testid="selection-toolbar" reappears (selection still active)

test 6: Selection toolbar reuses the same buttons as the static toolbar
- in editor mode, select 6 characters
- record the className of the button with title="Bold" inside data-testid="selection-toolbar"
- record the className of the button with title="Bold" inside the static toolbar (the bar above the editor)
- validate both buttons have the same `h-7 w-7` size classes and the same active/inactive color classes — the popup must reuse the FormatButton component, not a new inline element
