import os
from huggingface_hub import scan_cache_dir
try:
    cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
    print(f"Cache dir: {cache_dir}")
    info = scan_cache_dir(cache_dir=cache_dir) if cache_dir else scan_cache_dir()
    print("Success")
except Exception as e:
    print(f"Exception: {type(e).__name__}: {e}")
    if type(e).__name__ == "CacheNotFound":
        print("CacheNotFound exception caught.")
