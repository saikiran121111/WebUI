# Ruke QA issues

Read open items before validation. For older findings search [the existing register](../docs/overnight/FINDINGS.md) by ID before adding an entry. Append new confirmed failures here. Close an item with the passing reproducer, date and affected configuration.

| ID / status | Severity / component | Reproduction | Evidence | Fix verification |
| --- | --- | --- | --- | --- |
| F59–F61 / open on measured host | High / primary CPU OCR | Historical bounded cold load of PaddleOCR-VL-1.6 under the 3,814 MiB job limit produced zero pages. Follow the resource prerequisites in the handover before attempting a live repeat. | [Cold-load log](../docs/overnight/logs/f59-ocr-coldload-1.log), [handover §7](../docs/overnight/HANDOVER-2026-11-20.md) | Current admission can refuse before spawn. A bounded run returning a correctly attributed, scored page is still required. |
