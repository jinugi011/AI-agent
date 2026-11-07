#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.vector_store import CodeVectorStore


def main():
    project_root = "/Users/jinugi/Desktop/Project2026/YANGShopping"
    project_name = "YANGShopping"
    vector_store = CodeVectorStore("/Users/jinugi/Desktop/Project2026/AI-agent/backend/data/style_samples")
    vector_store.add_project_style(project_name, project_root)
    print(f"Indexed {project_name} from {project_root} into Qdrant")


if __name__ == "__main__":
    main()
