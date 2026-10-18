# Diagram selection

Choose the grammar from the question, not from visual preference.

| Question | Preferred Mermaid type | Avoid when |
| --- | --- | --- |
| What happens, branches, or depends on what? | `flowchart` | Exact time ordering between participants is central |
| Who sends which message, and in what order? | `sequenceDiagram` | The task is mainly static structure |
| Which states exist and what causes transitions? | `stateDiagram-v2` | The labels describe procedural steps rather than states |
| How are records related? | `erDiagram` | Runtime calls or ownership boundaries are the real topic |
| How do classes or interfaces relate? | `classDiagram` | The reader needs deployment or service architecture |
| When does scheduled work happen? | `gantt` | Dependencies matter more than dates |
| What is the high-level system boundary? | `flowchart` or supported C4 syntax | The target renderer has unknown C4 support |

## Direction

- Start with `TD` for mobile, long explanations, or layered flows.
- Start with `LR` for short pipelines and compact temporal progressions.
- Change direction after rendering if the target viewport becomes too wide or too tall.

## Split triggers

Split the diagram when any of these are true:

- it mixes context, components, and code-level detail
- more than one relationship type requires a separate legend
- the main path is obscured by optional and failure branches
- labels must be shortened until they lose meaning
- the diagram needs a different direction for different regions
