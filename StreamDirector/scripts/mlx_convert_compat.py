"""mlx_lm 실행 래퍼 - transformers 5.x LlamaConfig 검증 버그 우회 후 실행 (Kanana 등).

사용: python scripts/mlx_convert_compat.py convert --hf-path ... -q --mlx-path ...
      python scripts/mlx_convert_compat.py lora --model ... --train ...
"""

import runpy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from streamdirector.training import transformers_compat  # noqa: E402

transformers_compat.apply()


if __name__ == "__main__":
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        command, args = sys.argv[1], sys.argv[2:]
    else:
        command, args = "convert", sys.argv[1:]
    sys.argv = [f"mlx_lm.{command}", *args]
    runpy.run_module(f"mlx_lm.{command}", run_name="__main__")
