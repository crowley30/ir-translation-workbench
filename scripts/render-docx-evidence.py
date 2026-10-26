#!/usr/bin/env python3
"""Render synthetic DOCX exports with LibreOffice and inspect visible text coverage.

This is an evidence helper, not a Word compatibility or translation-quality test.
Inputs must be deliberately generated synthetic samples; no real IR content belongs
in the output directory or public repository.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
import fitz


def normalized(value: str) -> str:
    return "".join(value.split())


def inspect_docx(path: Path) -> dict:
    document = Document(path)
    paragraphs: list[str] = []
    blocks: list[dict] = []
    for child in document.element.body:
        if child.tag == qn("w:p"):
            paragraph = Paragraph(child, document)
            paragraphs.append(paragraph.text)
            blocks.append({"kind": "paragraph", "style": paragraph.style.name, "text": paragraph.text})
        elif child.tag == qn("w:tbl"):
            table = Table(child, document)
            rows = []
            for row in table.rows:
                cells = []
                for cell in row.cells:
                    texts = [paragraph.text for paragraph in cell.paragraphs]
                    paragraphs.extend(texts)
                    cells.append(texts)
                rows.append(cells)
            blocks.append({"kind": "table", "rows": rows})
    return {"blocks": blocks, "paragraphs": paragraphs}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("docs/evidence/p2-render"))
    parser.add_argument("--require-marker", default="模拟")
    parser.add_argument("--task-json", type=Path, help="Optional synthetic saved task for an independent exact-order comparison")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    records: list[dict] = []
    saved_task = json.loads(args.task_json.read_text(encoding="utf-8")) if args.task_json else None

    def run(command: list[str], env: dict | None = None) -> subprocess.CompletedProcess:
        print("RUN " + json.dumps(command, ensure_ascii=False), flush=True)
        started = time.monotonic()
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, env=env)
        records.append({"command": command, "exitCode": result.returncode, "seconds": round(time.monotonic() - started, 3), "stdout": result.stdout, "stderr": result.stderr})
        if result.returncode:
            raise RuntimeError(f"Command exited {result.returncode}: {command[0]}")
        return result

    report: dict = {"scope": "Synthetic exports only; LibreOffice rendering does not establish Microsoft Word compatibility, page fidelity, or translation quality.", "commands": records, "files": []}
    exit_code = 0
    try:
        report["libreOfficeVersion"] = run(["soffice", "--version"]).stdout.strip()
        poppler = run(["pdftoppm", "-v"])
        report["popplerVersion"] = (poppler.stdout + poppler.stderr).strip()
        with tempfile.TemporaryDirectory(prefix="ir-docx-render-", dir="/tmp") as working:
            temporary = Path(working)
            (temporary / "cache").mkdir()
            environment = {**os.environ, "XDG_CACHE_HOME": str(temporary / "cache")}
            for source in args.docx:
                source = source.resolve(strict=True)
                print(f"Rendering synthetic sample: {source.name}", flush=True)
                structure = inspect_docx(source)
                conversion = temporary / source.stem
                conversion.mkdir()
                profile = (conversion / "profile").as_uri()
                run(["soffice", f"-env:UserInstallation={profile}", "--headless", "--convert-to", "pdf:writer_pdf_Export", "--outdir", str(conversion), str(source)], environment)
                converted = conversion / f"{source.stem}.pdf"
                if not converted.is_file() or not converted.stat().st_size:
                    raise RuntimeError("LibreOffice returned success without a nonempty PDF")
                pdf_path = args.output / f"{source.stem}.pdf"
                shutil.copyfile(converted, pdf_path)
                run(["pdftoppm", "-png", "-r", "110", str(pdf_path), str(args.output / source.stem)], environment)
                with fitz.open(pdf_path) as pdf:
                    texts = [page.get_text() for page in pdf]
                    page_sizes = [[page.rect.width, page.rect.height] for page in pdf]
                    fonts = sorted({str(font[3]) for page in pdf for font in page.get_fonts()})
                visible = normalized("\n".join(texts))
                counts = Counter(normalized(text) for text in structure["paragraphs"] if normalized(text))
                missing = [{"text": text, "expectedOccurrences": count, "visibleOccurrences": visible.count(text)} for text, count in counts.items() if visible.count(text) < count]
                marker_present = args.require_marker in "\n".join(texts) and args.require_marker in "\n".join(structure["paragraphs"])
                text_path = args.output / f"{source.stem}.txt"
                text_path.write_text("\n\n".join(f"--- PAGE {index + 1} ---\n{text}" for index, text in enumerate(texts)), encoding="utf-8")
                result = {"sourceFilename": source.name, "sourceBytes": source.stat().st_size, "pdf": pdf_path.name, "pages": len(texts), "pageSizesPt": page_sizes, "fonts": fonts, "structure": structure["blocks"], "nonemptyParagraphs": sum(counts.values()), "missingVisibleParagraphs": missing, "requiredMarker": args.require_marker, "requiredMarkerVisible": marker_present}
                if saved_task:
                    bilingual = source.stem == "bilingual"
                    saved = {paragraph["id"]: paragraph for paragraph in saved_task["paragraphs"]}
                    expected = []
                    source_nodes = []
                    for block in saved_task["document"]["blocks"]:
                        if block["kind"] == "paragraph":
                            source_nodes.append(block)
                        else:
                            source_nodes.extend(paragraph for row in block["rows"] for cell in row["cells"] for paragraph in cell["paragraphs"])
                    for paragraph in source_nodes:
                        prefix = paragraph.get("list", {}).get("label", "")
                        prefix = prefix + " " if prefix else ""
                        if paragraph["paragraphId"] is None:
                            expected.append(paragraph["source"])
                        else:
                            if bilingual:
                                expected.append(prefix + paragraph["source"])
                            expected.append(prefix + saved[paragraph["paragraphId"]]["translation"])
                    result["savedTaskComparison"] = {"taskId": saved_task["id"], "mode": "bilingual" if bilingual else "chinese", "structuralParagraphs": len(source_nodes), "translatableParagraphs": len(saved), "expectedParagraphsAfterNotice": len(expected), "actualParagraphsAfterNotice": len(structure["paragraphs"]) - 1, "exactParagraphOrderAndText": structure["paragraphs"][1:] == expected, "humanEditedIdsAndRevisions": {p["id"]: p["revision"] for p in saved.values() if p["edited"]}}
                    if not result["savedTaskComparison"]["exactParagraphOrderAndText"]:
                        exit_code = 1
                report["files"].append(result)
                if missing or not marker_present:
                    exit_code = 1
                print(f"RESULT {source.name}: pages={len(texts)}, missing={len(missing)}, marker={marker_present}", flush=True)
    except Exception as error:
        report["error"] = str(error)
        exit_code = 1
    report["exitCode"] = exit_code
    (args.output / "render-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Evidence report: {args.output / 'render-report.json'}; exit={exit_code}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
