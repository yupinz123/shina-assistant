from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import requests
from bs4 import BeautifulSoup
import re
import urllib.parse

app = FastAPI()

# スマホ（Galaxy S25）からアクセスを許可するための設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def clean_product_name(raw_name):
    """商品名をきれいにするお掃除機能"""
    if not raw_name: return "不明な商品"
    # 不要なワードを削る
    junk_patterns = [
        r" - Yahoo!ショッピング", r" - タジマヤ", r" \| .*", r"：.*", 
        r" < .*", r" - Amazon", r"公式サイト", r"検索結果一覧", r"JANコード.*"
    ]
    name = raw_name
    for pattern in junk_patterns:
        name = re.sub(pattern, "", name)
    return name.strip()

@app.get("/search")
def search_product(code: str = Query(..., min_length=7)):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
    }
    
    # --- 1. Co-op公式サイト (PB商品) ---
    coop_url = f"https://mdinfo.jccu.coop/bb/shohindetail/{code}/"
    try:
        res = requests.get(coop_url, headers=headers, timeout=5)
        if res.status_code == 200 and "検索結果一覧" not in res.text:
            soup = BeautifulSoup(res.text, 'html.parser')
            name = clean_product_name(soup.title.string)
            # 画像取得：id="main_img" を探す
            img_tag = soup.find("img", id="main_img")
            img_url = urllib.parse.urljoin(coop_url, img_tag.get("src")) if img_tag else None
            return {"name": name, "image": img_url, "source": "coop", "detail_url": coop_url}
    except: pass

    # --- 2. Yahoo!検索 (NB商品・画像も頑張る) ---
    # ブロックを避けるために通常の検索ページから画像を抽出
    yahoo_url = f"https://search.yahoo.co.jp/search?p={code}"
    try:
        res = requests.get(yahoo_url, headers=headers, timeout=5)
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # 名前取得
        name_tag = soup.select_one('h3')
        name = clean_product_name(name_tag.get_text()) if name_tag else "不明な商品"
        
        # 画像取得（Yahoo検索のサムネイルを狙う）
        # 検索結果に紐付く画像があれば取得
        img_tag = soup.find("img")
        img_url = img_tag.get("src") if img_tag else None
        
        # 画像が取れない場合の予備検索リンク
        search_link = f"https://www.google.com/search?q={code}&tbm=isch"
        
        return {
            "name": name, 
            "image": img_url, 
            "source": "net", 
            "search_link": search_link if not img_url else None
        }
    except: pass

    return {"name": "見つかりませんでした", "image": None}

# サーバー起動用（VS Codeのターミナルで実行）
# uvicorn main:app --reload