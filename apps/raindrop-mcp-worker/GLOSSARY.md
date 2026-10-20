# Raindrop MCP — Domain Glossary

Canonical domain language for the private Raindrop MCP Worker. Public tool naming uses these terms; the upstream REST API may use different endpoint names.

**Bookmark**:
An entry saved in Raindrop.io, including its URL and associated metadata or annotations. The Raindrop REST API calls such an entry a *Raindrop*.
_Avoid_: Raindrop as a second public MCP resource noun; generic item

**Collection**:
A named grouping of bookmarks that may be nested under another collection.
_Avoid_: Folder as a public tool resource noun

**Tag**:
A label associated with bookmarks for organizing and finding them.
_Avoid_: Category when referring to a tag

**Highlight**:
Selected text or annotation attached to a bookmark.
_Avoid_: Note as a synonym for a highlight

**Trash**:
The location for deleted bookmarks before their permanent removal.
_Avoid_: Deleted collection as a public resource synonym

**Permanent deletion**:
Removal of a bookmark already in Trash such that it cannot be recovered through ordinary Trash restoration.
_Avoid_: Ordinary bookmark deletion as a synonym

**Collection subtree**:
A collection together with all its nested descendant collections, which may be affected by deleting the parent collection.
_Avoid_: The direct bookmarks of a parent as a complete impact scope
