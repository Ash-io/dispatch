// Everything src/js/ui/codeedit.js uses from CodeMirror. Rebuild with scripts/build-codemirror.sh.
export { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  placeholder, Decoration, MatchDecorator, ViewPlugin, hoverTooltip, rectangularSelection,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, isolateHistory } from '@codemirror/commands';
export {
  StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, foldGutter, foldService, foldEffect,
  codeFolding, foldCode, unfoldCode, foldAll, unfoldAll, indentUnit, indentOnInput,
} from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, startCompletion, acceptCompletion } from '@codemirror/autocomplete';
export { linter, lintGutter, setDiagnostics, forEachDiagnostic } from '@codemirror/lint';
export { search, searchKeymap, openSearchPanel, closeSearchPanel, highlightSelectionMatches } from '@codemirror/search';
export { tags } from '@lezer/highlight';
