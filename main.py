import requests
from bs4 import BeautifulSoup
import re

# 検索結果を綺麗にする関数
def clean_product_name(raw_name):
    if not raw_name: return "不明な商品"
    # 不要なワードを徹底削除
    junk = [r" - Yahoo!ショッピング", r" - タジマヤ", r" \| .*", r"：.*", r"の商品をすべて見る.*", r"（\d+件）"]
    name = raw_name
    for p in junk:
        name = re.sub(p, "", name)
    return name.strip()

def get_product_details(code):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36..."}
    
    # JANコードで検索した時の「最初の商品」をピンポイントで狙う
    url = f"https://shopping.yahoo.co.jp/search?p={code}"
    try:
        res = requests.get(url, headers=headers, timeout=5)
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # 商品名が入っているタグをより正確に指定
        # Yahooショッピングの検索結果の1件目を抽出
        item = soup.select_one('li.LoopList__item')
        if item:
            name_tag = item.select_one('.SearchResultItemTitle__name')
            img_tag = item.select_one('img')
            
            if name_tag:
                return clean_product_name(name_tag.get_text()), img_tag.get("src")
    except:
        pass

    return "商品名が見つかりませんでした", None