---
name: mermaid-diagram-builder
description: Turn requirements, prose, code, or structured notes into a focused Mermaid diagram. Use when a new diagram must be designed from source material; do not use merely to restyle an existing Mermaid diagram or choose final publishing assets.
---

# Mermaid Diagram Builder

Build the diagram as an evidence-backed model, not as decoration. The result should make one important relationship, sequence, state model, or data structure easier to understand than the source material alone.

## Establish the diagram contract

Before writing Mermaid, identify:

- the question the diagram must answer
- the intended reader and viewing context
- facts explicitly supported by the source
- unknown or proposed relationships that must not be presented as facts
- the smallest diagram grammar that fits the question

If the diagram type is unclear, read [references/diagram-selection.md](references/diagram-selection.md).

## Build the semantic core

1. Extract entities, relationships, ordering, decisions, and boundaries from the source.
2. Remove details that do not help answer the primary question.
3. Use descriptive labels that remain short enough to scan.
4. Create the smallest complete Mermaid draft before adding error paths or secondary detail.
5. Add only the branches, notes, or subgraphs required to preserve correctness.

Do not invent components, calls, states, or data flows to make the diagram look complete. Mark unresolved items outside the diagram as assumptions or questions.

## Control complexity

- Keep one abstraction level per diagram.
- Prefer multiple linked diagrams when the source mixes system context, internal components, and runtime sequence.
- Treat 12 nodes as a review trigger, not an absolute limit. Split when a reader must repeatedly zoom or trace crossings.
- Prefer native Mermaid constructs over styling tricks.
- Do not add `classDef`, colors, or custom themes until the structure is correct.

## Validate

Render with an already available Mermaid renderer when possible.

- If parsing fails, use the exact parser error to make the smallest syntax correction.
- If parsing succeeds, verify that every rendered edge and label still matches the source.
- Distinguish syntax validation from factual validation.
- If no renderer is available, return editable Mermaid source and disclose that it was not rendered.

## Deliver

Provide:

1. editable Mermaid source
2. a one-sentence statement of what the diagram explains
3. assumptions or unresolved questions, when present
4. the rendered preview or validation status

Keep explanations outside the Mermaid block so the source remains directly reusable.
