# -*- coding: utf-8 -*-
import os
import re
import json

PORTUGUESE_MARKERS = {
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas',
  'que', 'para', 'com', 'por', 'sobre', 'como', 'mais', 'foi', 'sao', 'são', 'esta', 'está', 'este',
  'nesta', 'neste', 'ao', 'aos', 'pela', 'pelo', 'pelas', 'pelos', 'entre', 'contra', 'apos', 'após',
  'ate', 'até', 'governo', 'policia', 'polícia', 'camara', 'câmara', 'cidade', 'estado',
  'moradores', 'municipio', 'município', 'seguranca', 'segurança', 'saude', 'saúde',
  'educacao', 'educação', 'transporte', 'justica', 'justiça'
}

ENGLISH_MARKERS = {
  'the', 'and', 'of', 'to', 'in', 'for', 'with', 'without', 'from', 'this', 'that', 'what', 'why', 'who',
  'have', 'has', 'been', 'are', 'is', 'was', 'were', 'claim', 'claims', 'residents', 'social', 'costs',
  'data', 'centers', 'big', 'tech', 'hub', 'water', 'day', 'movements', 'right', 'began', 'occupation',
  'talks', 'waste', 'pickers', 'sustainability', 'retraining', 'after', 'before', 'police', 'city',
  'hall', 'port', 'railway', 'corridor', 'summit', 'development', 'trade', 'women', 'memory'
}

def count_markers(text, markers):
    tokens = re.findall(r'[a-zA-ZÀ-ÿ]+', (text or "").lower())
    return sum(1 for t in tokens if t in markers)

def portuguese_accent_bonus(text):
    matches = re.findall(r'[áàâãéêíóôõúüç]', text or "", re.IGNORECASE)
    return min(len(matches), 12) if matches else 0

def clean_up_pipeline():
    repo = "/home/ubuntu/gsn"
    blog_dir = os.path.join(repo, "src/content/blog")
    queue_path = os.path.join(repo, "tools/gsn_hourly_queue.json")
    
    if not os.path.exists(blog_dir):
        print(f"Directory {blog_dir} does not exist.")
        return

    # Load queue
    queue = []
    if os.path.exists(queue_path):
        try:
            with open(queue_path, "r", encoding="utf-8") as f:
                queue = json.load(f)
        except Exception as e:
            print("Error reading queue:", e)

    deleted_files = set()
    all_files = [f for f in os.listdir(blog_dir) if f.endswith(".md")]
    
    for filename in all_files:
        filepath = os.path.join(blog_dir, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
            
        # Parse body
        body = content
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                body = parts[2]
                
        # Check language
        sample = content[:4000]
        english = count_markers(sample, ENGLISH_MARKERS)
        portuguese = count_markers(sample, PORTUGUESE_MARKERS) + portuguese_accent_bonus(sample)
        
        is_portuguese = portuguese > english
        
        # Check placeholders / metadata
        has_placeholder = any(p in content for p in [
            "Editorial queue brief",
            "Review headline",
            "before final publication",
            "intentionally concise",
            "expanded by the editorial writer"
        ])
        
        should_delete = is_portuguese or has_placeholder or len(body.strip()) < 800
        
        if should_delete:
            reason = []
            if is_portuguese: reason.append("Spanish/Portuguese content")
            if has_placeholder: reason.append("Metalinguistic placeholder")
            if len(body.strip()) < 800: reason.append(f"Short body ({len(body.strip())} chars)")
            
            print(f"Deleting {filename}: {', '.join(reason)}")
            try:
                os.remove(filepath)
                deleted_files.add(filename)
            except Exception as e:
                print(f"Error removing {filename}: {e}")

    # Update queue
    new_queue = [item for item in queue if item not in deleted_files]
    if len(new_queue) != len(queue):
        print(f"Updating queue: reduced from {len(queue)} to {len(new_queue)} items")
        try:
            with open(queue_path, "w", encoding="utf-8") as f:
                json.dump(new_queue, f, ensure_ascii=False, indent=2)
                f.write("\n")
        except Exception as e:
            print("Error writing queue:", e)
    else:
        print("Queue did not contain deleted files or was already clean.")

if __name__ == "__main__":
    clean_up_pipeline()
