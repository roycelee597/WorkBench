"""增加指标时在这里登记，页面从元数据发现指标。"""

from .index_valuation import IndexValuation
from .new_high_60d import NewHigh60d
from .top5_turnover import Top5Turnover

INDICATORS = [Top5Turnover(), NewHigh60d(), IndexValuation()]
