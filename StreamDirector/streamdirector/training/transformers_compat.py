"""transformers 5.x LlamaConfig 검증 버그 우회.

Kanana 1.5 처럼 head_dim 을 명시한 Llama 계열(hidden 1792, heads 24, head_dim 128)은 정상 구조인데
transformers 5.19 의 validate_architecture 가 hidden_size % heads 만 검사해 로딩을 거부한다.
apply() 는 해당 검증을 head_dim 을 고려하도록 교체한다 (라이브러리 파일은 수정하지 않음).
"""


def apply() -> None:
    from transformers.models.llama import configuration_llama as cl

    def validate_architecture(self):
        head_dim = getattr(self, "head_dim", None) or self.hidden_size // self.num_attention_heads
        if head_dim <= 0 or self.num_attention_heads % max(1, self.num_key_value_heads) != 0:
            raise ValueError("invalid attention configuration")

    cl.LlamaConfig.validate_architecture = validate_architecture
    # huggingface_hub strict dataclass 는 클래스 생성 시 검증 함수 목록을 따로 보관하므로 그 목록도 교체
    cl.LlamaConfig.__class_validators__ = [
        validate_architecture if getattr(v, "__name__", "") == "validate_architecture" else v
        for v in cl.LlamaConfig.__class_validators__
    ]
