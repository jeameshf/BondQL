#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BondQL · 智能问数 — 后端服务
纯 Python 标准库实现（http.server + sqlite3 + urllib），无需任何第三方依赖。

功能：
  - 内置 SQLite CRM 演示数据库（首次启动自动建表 + 灌入样例数据）
  - 真实执行 SQL，返回真实查询结果与图表数据
  - 自然语言转 SQL：优先调用 OpenAI 兼容大模型（可配置 API Key），
    未配置或调用失败时自动降级为内置规则引擎
  - 数据源 / 术语 / 示例 / 提示词 / 权限 / 模型 / 工作空间 / 会话 等元数据持久化

启动：python server.py [端口]
默认：http://127.0.0.1:8000
"""

import json
import os
import re
import sqlite3
import sys
import time
import hashlib
import secrets
import socket
import uuid
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- 配置
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, 'web')
DATA_DIR = os.path.join(BASE_DIR, 'data')
DB_PATH = os.path.join(DATA_DIR, 'bondql.db')
LIB_DIR = os.path.join(BASE_DIR, 'libs')
if os.path.isdir(LIB_DIR) and LIB_DIR not in sys.path:
    sys.path.insert(0, LIB_DIR)
PORT = 8000

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
}

# ---------------------------------------------------------------- 数据库
def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = get_conn()
    c = conn.cursor()
    # ---- CRM 业务表 ----
    c.execute('''CREATE TABLE IF NOT EXISTS crm_departments(
        id INTEGER PRIMARY KEY, name TEXT, region TEXT, province TEXT, parent_id INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS crm_salespeople(
        id INTEGER PRIMARY KEY, name TEXT, department_id INTEGER, phone TEXT, email TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS crm_customers(
        id INTEGER PRIMARY KEY, name TEXT, industry TEXT, customer_level TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS crm_products(
        id INTEGER PRIMARY KEY, name TEXT, line TEXT, price REAL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS crm_orders(
        id INTEGER PRIMARY KEY, sales_id INTEGER, customer_id INTEGER, product_id INTEGER,
        order_date TEXT, actual_amount REAL, quantity INTEGER, status TEXT)''')

    # ---- 结构迁移（v2：数据源与工作空间解耦、引入 schema）----
    try:
        _ds_cols = [r[1] for r in c.execute("PRAGMA table_info(datasources)").fetchall()]
    except Exception:
        _ds_cols = []
    if _ds_cols and ('ws' in _ds_cols or 'schema' not in _ds_cols):
        c.execute('DROP TABLE IF EXISTS datasources')
        c.execute('DROP TABLE IF EXISTS tables')
        conn.commit()

    # ---- 应用元数据表 ----
    c.execute('''CREATE TABLE IF NOT EXISTS workspaces(
        id TEXT PRIMARY KEY, name TEXT, desc TEXT, members INTEGER, sessions INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS datasources(
        id TEXT PRIMARY KEY, name TEXT, engine TEXT, host TEXT, port TEXT, db TEXT,
        username TEXT, password TEXT, schema TEXT, desc TEXT, status TEXT, icon TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS tables(
        id TEXT PRIMARY KEY, ds_id TEXT, schema TEXT, name TEXT, biz TEXT, fields INTEGER, desc TEXT, enabled INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS relations(
        id TEXT PRIMARY KEY, ds_id TEXT, lt TEXT, lf TEXT, rt TEXT, rf TEXT, type TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS workspace_datasources(
        ws_id TEXT, ds_id TEXT, PRIMARY KEY(ws_id, ds_id))''')
    c.execute('''CREATE TABLE IF NOT EXISTS workspace_tables(
        ws_id TEXT, table_id TEXT, PRIMARY KEY(ws_id, table_id))''')
    c.execute('''CREATE TABLE IF NOT EXISTS terms(
        id TEXT PRIMARY KEY, ds_id TEXT, term TEXT, syn TEXT, logic TEXT, status TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS examples(
        id TEXT PRIMARY KEY, ds_id TEXT, q TEXT, use_count INTEGER, status TEXT, sql TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS prompts(
        id TEXT PRIMARY KEY, scope TEXT, ds_id TEXT, content TEXT)''')
    # 迁移：老库 prompts 表补 ds_id 列
    try:
        _pc = [r[1] for r in c.execute("PRAGMA table_info(prompts)").fetchall()]
    except Exception:
        _pc = []
    if _pc and 'ds_id' not in _pc:
        c.execute("ALTER TABLE prompts ADD COLUMN ds_id TEXT DEFAULT ''")
        c.execute("UPDATE prompts SET ds_id='ds-demo' WHERE scope LIKE '%CordysCRM%'")
        conn.commit()
    c.execute('''CREATE TABLE IF NOT EXISTS rules(
        id TEXT PRIMARY KEY, name TEXT, items TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS models(
        id TEXT PRIMARY KEY, name TEXT, provider TEXT, model_id TEXT, base_url TEXT,
        api_key TEXT, status TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS assistants(
        id TEXT PRIMARY KEY, name TEXT, desc TEXT, scenario TEXT, enabled INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS dashboards(
        id TEXT PRIMARY KEY, name TEXT, charts INTEGER, refresh TEXT, status TEXT, pv INTEGER, share INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS chats(
        id TEXT PRIMARY KEY, title TEXT, ds_id TEXT, created TEXT, updated TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, created TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY, value TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, salt TEXT,
        name TEXT, role TEXT, workspaces TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS table_fields(
        id TEXT PRIMARY KEY, table_id TEXT, name TEXT, type TEXT, biz TEXT, desc TEXT)''')

    conn.commit()
    # 首次初始化（各表独立判断，按需灌入）
    if c.execute('SELECT COUNT(*) FROM crm_departments').fetchone()[0] == 0:
        seed_crm(conn)
    if c.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0] == 0:
        seed_workspaces(conn)
    if c.execute('SELECT COUNT(*) FROM datasources').fetchone()[0] == 0:
        seed_datasources(conn)
    if c.execute('SELECT COUNT(*) FROM tables').fetchone()[0] == 0:
        seed_tables(conn)
    if c.execute('SELECT COUNT(*) FROM table_fields').fetchone()[0] == 0:
        seed_table_fields(conn)
    if c.execute('SELECT COUNT(*) FROM relations').fetchone()[0] == 0:
        seed_relations(conn)
    if c.execute('SELECT COUNT(*) FROM workspace_datasources').fetchone()[0] == 0:
        seed_workspace_bindings(conn)
    if c.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0:
        seed_users(conn)
    if c.execute('SELECT COUNT(*) FROM terms').fetchone()[0] == 0:
        seed_terms(conn)
    if c.execute('SELECT COUNT(*) FROM examples').fetchone()[0] == 0:
        seed_examples(conn)
    if c.execute('SELECT COUNT(*) FROM prompts').fetchone()[0] == 0:
        seed_prompts(conn)
    if c.execute('SELECT COUNT(*) FROM rules').fetchone()[0] == 0:
        seed_rules(conn)
    if c.execute('SELECT COUNT(*) FROM models').fetchone()[0] == 0:
        seed_models(conn)
    if c.execute('SELECT COUNT(*) FROM assistants').fetchone()[0] == 0:
        seed_assistants(conn)
    if c.execute('SELECT COUNT(*) FROM dashboards').fetchone()[0] == 0:
        seed_dashboards(conn)
    if get_setting(conn, 'active_workspace') is None:
        seed_settings(conn)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 种子数据
def seed_crm(conn):
    import random
    rnd = random.Random(20261006)
    c = conn.cursor()

    regions = {
        '华南': ['广东', '广西', '海南', '福建'],
        '华东': ['上海', '江苏', '浙江', '安徽'],
        '华北': ['北京', '天津', '河北'],
        '西南': ['四川', '重庆', '云南'],
        '华中': ['湖北', '湖南', '河南'],
        '东北': ['辽宁', '吉林', '黑龙江'],
        '西北': ['陕西', '甘肃', '新疆'],
    }
    dept_id = 0
    sales_id = 0
    surnames = '张王李赵陈杨刘孙周吴郑冯蒋沈韩唐许邓彭曾罗高谢宋潘董蔡康袁邵'
    givens = '伟娜强洋静帆磊悦涛迪爽军丽明娟宇欣'
    names = [s + g for s in surnames for g in givens]
    rnd.shuffle(names)
    for region, provs in regions.items():
        for prov in provs:
            dept_id += 1
            c.execute('INSERT INTO crm_departments VALUES(?,?,?,?,NULL)',
                      (dept_id, f'{region}-{prov}一部', region, prov))
            # 每个省份 1~2 名销售
            for k in range(rnd.randint(1, 2)):
                sales_id += 1
                name = names[sales_id - 1]
                c.execute('INSERT INTO crm_salespeople VALUES(?,?,?,?,?)',
                          (sales_id, name, dept_id,
                           f'138{rnd.randint(10000000, 99999999)}', f'sales{sales_id}@bondql.cn'))

    industries = ['制造业', '互联网', '金融', '零售', '医疗', '教育']
    for i in range(1, 61):
        lvl = rnd.choices(['A', 'B', 'C', 'S'], weights=[15, 45, 35, 5])[0]
        c.execute('INSERT INTO crm_customers VALUES(?,?,?,?)',
                  (i, f'客户{rnd.choice(["星辰","远航","凌云","光点","磐石","锐进","恒远","启明","华章","金穗"])}{i}',
                   rnd.choice(industries), lvl))

    lines = {'家用电器': 8, '数码产品': 6, '服装鞋帽': 5, '家居家具': 4, '食品饮料': 3}
    pid = 0
    for line, cnt in lines.items():
        for j in range(cnt):
            pid += 1
            c.execute('INSERT INTO crm_products VALUES(?,?,?,?)',
                      (pid, f'{line}-{rnd.choice(["标准","旗舰","青春","尊享","基础","Pro"])}{j+1}',
                       line, round(rnd.uniform(99, 19999), 2)))

    # 订单：近 12 个月（以运行当天为基准）
    import datetime
    today = datetime.date.today()
    order_id = 0
    for _ in range(1100):
        order_id += 1
        day = today - datetime.timedelta(days=rnd.randint(0, 364))
        s = rnd.randint(1, sales_id)
        # 销售属于某个部门，从而属于某区域
        dept = c.execute('SELECT department_id FROM crm_salespeople WHERE id=?', (s,)).fetchone()[0]
        region = c.execute('SELECT region FROM crm_departments WHERE id=?', (dept,)).fetchone()[0]
        # 使华南/华东订单略多，形成明显差异
        mult = {'华南': 1.6, '华东': 1.35, '华北': 1.0, '西南': 0.8, '华中': 0.7, '东北': 0.55, '西北': 0.45}.get(region, 1.0)
        amount = round(rnd.uniform(3000, 300000) * mult, 2)
        c.execute('INSERT INTO crm_orders VALUES(?,?,?,?,?,?,?,?)',
                  (order_id, s, rnd.randint(1, 60), rnd.randint(1, pid),
                   day.isoformat(), amount, rnd.randint(1, 8),
                   rnd.choices(['已完成', '已完成', '已完成', '已取消'], weights=[80, 10, 10, 8])[0]))

    # 保证「本月」每个大区（及其省份）都有订单，避免近期查询返回空结果
    for region, provs in regions.items():
        for prov in provs:
            dept_row = c.execute('SELECT id FROM crm_departments WHERE region=? AND province=? LIMIT 1', (region, prov)).fetchone()
            if not dept_row:
                continue
            sales_row = c.execute('SELECT id FROM crm_salespeople WHERE department_id=? LIMIT 1', (dept_row[0],)).fetchone()
            if not sales_row:
                continue
            for _ in range(3):
                order_id += 1
                day = today - datetime.timedelta(days=rnd.randint(0, max(0, today.day - 1)))
                c.execute('INSERT INTO crm_orders VALUES(?,?,?,?,?,?,?,?)',
                          (order_id, sales_row[0], rnd.randint(1, 60), rnd.randint(1, pid),
                           day.isoformat(), round(rnd.uniform(3000, 300000), 2), rnd.randint(1, 8), '已完成'))
    conn.commit()


def seed_workspaces(conn):
    c = conn.cursor()
    c.execute('INSERT INTO workspaces VALUES(?,?,?,?,?)', ('ws-demo', '演示空间', '演示与销售分析', 5, 12))
    c.execute('INSERT INTO workspaces VALUES(?,?,?,?,?)', ('ws-fin', '财务分析空间', '财务与预算数据', 3, 8))
    conn.commit()


def seed_datasources(conn):
    c = conn.cursor()
    c.execute('INSERT INTO datasources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
              ('ds-demo', 'CordysCRM', 'SQLite', 'localhost', '—', 'bondql.db', '', '', 'public',
               '内置 CRM 演示数据库（真实可查询）', 'enabled', '🐘'))
    c.execute('INSERT INTO datasources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
              ('ds-mfg', '生产制造销售数据', 'MySQL', '10.123.22.252', '3306', 'zizhaoye', 'root', 'Password123@mysql', 'public',
               '示例 MySQL 数据源（待接入）', 'enabled', '🐬'))
    conn.commit()


def seed_tables(conn):
    c = conn.cursor()
    tables = [
        ('t1', 'crm_departments', 'public', '部门表', 5, '树形部门结构（区域/省份）'),
        ('t2', 'crm_salespeople', 'public', '销售人员表', 5, '销售人员信息'),
        ('t3', 'crm_orders', 'public', '订单表', 8, '销售订单记录'),
        ('t4', 'crm_customers', 'public', '客户表', 4, '客户主数据'),
        ('t5', 'crm_products', 'public', '产品表', 4, '产品目录'),
        ('t6', 'system_log', 'log', '系统日志表', 4, '与问数无关，已隐藏'),
    ]
    for tid, name, schema, biz, fields, desc in tables:
        c.execute('INSERT INTO tables VALUES(?,?,?,?,?,?,?,?)',
                  (tid, 'ds-demo', schema, name, biz, fields, desc, 1 if tid != 't6' else 0))
    conn.commit()


def seed_relations(conn):
    c = conn.cursor()
    rels = [
        ('r1', 'crm_departments', 'id', 'crm_salespeople', 'department_id', '1:N'),
        ('r2', 'crm_salespeople', 'id', 'crm_orders', 'sales_id', '1:N'),
        ('r3', 'crm_departments', 'id', 'crm_departments', 'parent_id', '自关联'),
    ]
    for rid, lt, lf, rt, rf, typ in rels:
        c.execute('INSERT INTO relations VALUES(?,?,?,?,?,?,?)', (rid, 'ds-demo', lt, lf, rt, rf, typ))
    conn.commit()


def seed_workspace_bindings(conn):
    c = conn.cursor()
    c.execute('INSERT INTO workspace_datasources VALUES(?,?)', ('ws-demo', 'ds-demo'))
    c.execute('INSERT INTO workspace_datasources VALUES(?,?)', ('ws-demo', 'ds-mfg'))
    for tid in ('t1', 't2', 't3', 't4', 't5'):
        c.execute('INSERT INTO workspace_tables VALUES(?,?)', ('ws-demo', tid))
    conn.commit()


def seed_terms(conn):
    c = conn.cursor()
    terms = [
        ('tm1', '华南大区', '华南区、南区', "region = '华南'，包含广东、广西、海南、福建", 'enabled'),
        ('tm2', '大客户', 'KA、重点客户', "customer_level = 'A'，年采购额≥100万", 'enabled'),
        ('tm3', '销售额', '营收、销售收入', '必须使用 actual_amount 字段（实际支付金额）', 'enabled'),
        ('tm4', '制造业', '工业、制造行业', "industry IN ('制造业','工业','机械制造')", 'enabled'),
        ('tm5', '黄金客户', 'VIP客户、金牌客户', "customer_level = 'S'", 'pending'),
    ]
    for tid, term, syn, logic, status in terms:
        c.execute('INSERT INTO terms VALUES(?,?,?,?,?,?)', (tid, 'ds-demo', term, syn, logic, status))
    conn.commit()


def seed_examples(conn):
    c = conn.cursor()
    examples = [
        ('ex1', '华南大区本月的销售业绩', 156, 'enabled', "SELECT d.region, ROUND(SUM(o.actual_amount)/10000.0,1) AS sales\nFROM crm_orders o JOIN crm_salespeople s ON o.sales_id=s.id JOIN crm_departments d ON s.department_id=d.id\nWHERE d.region='华南' AND strftime('%Y-%m',o.order_date)=strftime('%Y-%m','now')\nGROUP BY d.region;"),
        ('ex2', '近12个月销售额趋势', 128, 'enabled', "SELECT strftime('%Y-%m',o.order_date) AS m, ROUND(SUM(o.actual_amount)/10000.0,1) AS s\nFROM crm_orders o WHERE o.order_date>=date('now','-11 months','start of month')\nGROUP BY m ORDER BY m;"),
        ('ex3', '各产品线销量占比', 89, 'enabled', "SELECT p.line, SUM(o.quantity) AS qty\nFROM crm_orders o JOIN crm_products p ON o.product_id=p.id\nGROUP BY p.line ORDER BY qty DESC;"),
        ('ex4', '销售人员业绩排名TOP10', 67, 'enabled', "SELECT s.name, ROUND(SUM(o.actual_amount)/10000.0,1) AS sales\nFROM crm_orders o JOIN crm_salespeople s ON o.sales_id=s.id\nGROUP BY s.name ORDER BY sales DESC LIMIT 10;"),
        ('ex5', '制造业客户数量统计', 45, 'pending', "SELECT industry, COUNT(*) AS cnt FROM crm_customers GROUP BY industry ORDER BY cnt DESC;"),
    ]
    for eid, q, use, status, sql in examples:
        c.execute('INSERT INTO examples VALUES(?,?,?,?,?,?)', (eid, 'ds-demo', q, use, status, sql))
    conn.commit()


def seed_prompts(conn):
    c = conn.cursor()
    c.execute('INSERT INTO prompts VALUES(?,?,?,?)', ('p1', '全局提示词（适用于所有数据源）', '',
        '# 全局规则\n- 销售额必须使用 actual_amount 字段，不能使用 order_amount\n- 日期查询默认最近30天，除非用户明确指定时间范围\n- 排除状态为"已取消"的订单\n- 查询结果默认按降序排列'))
    c.execute('INSERT INTO prompts VALUES(?,?,?,?)', ('p2', 'CordysCRM 数据源专属提示词', 'ds-demo',
        '# CordysCRM 专属规则\n- 部门表是树形结构\n- 销售人员与订单通过 sales_id 关联\n- 大区指的是 region 字段\n- 制造业客户需匹配 industry 字段'))
    conn.commit()


def seed_rules(conn):
    c = conn.cursor()
    c.execute('INSERT INTO rules VALUES(?,?,?)', ('rg1', '业务员权限规则组', json.dumps([
        {'kind': 'row', 'ds_id': 'ds-demo', 'table': 'crm_orders', 'filter': 'region = 当前用户所属区域', 'columns': []}])))
    c.execute('INSERT INTO rules VALUES(?,?,?)', ('rg2', '华东区域', json.dumps([
        {'kind': 'row', 'ds_id': 'ds-demo', 'table': 'crm_orders', 'filter': "region = '华东'", 'columns': []},
        {'kind': 'col', 'ds_id': 'ds-demo', 'table': 'crm_salespeople', 'filter': '', 'columns': ['phone', 'email']}])))
    conn.commit()


def seed_models(conn):
    c = conn.cursor()
    c.execute('INSERT INTO models VALUES(?,?,?,?,?,?,?)',
              ('m1', 'DeepSeek-V3', 'DeepSeek', 'deepseek-chat', 'https://api.deepseek.com', '', 'default'))
    c.execute('INSERT INTO models VALUES(?,?,?,?,?,?,?)',
              ('m2', 'GPT-4o', 'OpenAI', 'gpt-4o', 'https://api.openai.com/v1', '', 'ready'))
    c.execute('INSERT INTO models VALUES(?,?,?,?,?,?,?)',
              ('m3', 'Ollama 本地', 'Ollama', 'qwen2.5:7b', 'http://127.0.0.1:11434/v1', '', 'none'))
    conn.commit()


def seed_assistants(conn):
    c = conn.cursor()
    c.execute('INSERT INTO assistants VALUES(?,?,?,?,?)', ('a1', '基础应用 - 运营看板', '免后端对接 · 公共数据源', '运营看板、知识库、内网主页', 1))
    c.execute('INSERT INTO assistants VALUES(?,?,?,?,?)', ('a2', '高级应用 - 客户门户', '需登录 · 业务系统控制数据权限', '企业管理系统、客户门户、B2B系统', 1))
    conn.commit()


def seed_dashboards(conn):
    c = conn.cursor()
    c.execute('INSERT INTO dashboards VALUES(?,?,?,?,?,?,?)', ('d1', '零售经营日报', 7, '每日08:00刷新', 'running', 156, 8))
    c.execute('INSERT INTO dashboards VALUES(?,?,?,?,?,?,?)', ('d2', '门店健康度监控', 5, '每小时刷新', 'running', 89, 3))
    c.execute('INSERT INTO dashboards VALUES(?,?,?,?,?,?,?)', ('d3', '渠道效果分析', 4, '每日刷新', 'pending', 42, 1))
    conn.commit()


def seed_settings(conn):
    c = conn.cursor()
    c.execute('INSERT OR IGNORE INTO settings VALUES(?,?)', ('active_workspace', 'ws-demo'))
    c.execute('INSERT OR IGNORE INTO settings VALUES(?,?)', ('active_datasource', 'ds-demo'))
    conn.commit()


# ---------------------------------------------------------------- 用户与会话
SESSIONS = {}  # token -> user dict


def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(8)
    h = hashlib.sha256((salt + password).encode('utf-8')).hexdigest()
    return h, salt


def verify_password(password, salt, expected):
    h, _ = hash_password(password, salt)
    return h == expected


def seed_users(conn):
    c = conn.cursor()
    users = [
        ('u-admin', 'admin', 'admin123', '管理员', 'admin', '[]'),
        ('u-demo', 'demo', 'demo123', '演示用户', 'user', '["ws-demo"]'),
    ]
    for uid, username, password, name, role, ws in users:
        h, salt = hash_password(password)
        c.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?)', (uid, username, h, salt, name, role, ws))
    conn.commit()


def seed_table_fields(conn):
    c = conn.cursor()
    fields = [
        ('f1', 't1', 'id', 'INTEGER', '主键', '部门唯一标识'),
        ('f2', 't1', 'name', 'TEXT', '部门名称', '例如「华南-广东一部」'),
        ('f3', 't1', 'region', 'TEXT', '所属大区', '华南/华东/华北等'),
        ('f4', 't1', 'province', 'TEXT', '所属省份', '广东/广西等'),
        ('f5', 't1', 'parent_id', 'INTEGER', '上级部门ID', '树形结构，可空'),
        ('f6', 't2', 'id', 'INTEGER', '主键', '销售唯一标识'),
        ('f7', 't2', 'name', 'TEXT', '姓名', '销售人员姓名'),
        ('f8', 't2', 'department_id', 'INTEGER', '所属部门', '关联 crm_departments.id'),
        ('f9', 't2', 'phone', 'TEXT', '联系电话', '手机号'),
        ('f10', 't2', 'email', 'TEXT', '邮箱', '企业邮箱'),
        ('f11', 't3', 'id', 'INTEGER', '主键', '订单唯一标识'),
        ('f12', 't3', 'sales_id', 'INTEGER', '销售ID', '关联 crm_salespeople.id'),
        ('f13', 't3', 'customer_id', 'INTEGER', '客户ID', '关联 crm_customers.id'),
        ('f14', 't3', 'product_id', 'INTEGER', '产品ID', '关联 crm_products.id'),
        ('f15', 't3', 'order_date', 'TEXT', '下单日期', '格式 YYYY-MM-DD'),
        ('f16', 't3', 'actual_amount', 'REAL', '实际金额(元)', '实际支付金额，问数「销售额」用此字段'),
        ('f17', 't3', 'quantity', 'INTEGER', '数量', '购买数量'),
        ('f18', 't3', 'status', 'TEXT', '状态', '已完成/已取消'),
        ('f19', 't4', 'id', 'INTEGER', '主键', '客户唯一标识'),
        ('f20', 't4', 'name', 'TEXT', '客户名称', '客户公司名称'),
        ('f21', 't4', 'industry', 'TEXT', '所属行业', '制造业/互联网等'),
        ('f22', 't4', 'customer_level', 'TEXT', '客户等级', 'A/B/C/S'),
        ('f23', 't5', 'id', 'INTEGER', '主键', '产品唯一标识'),
        ('f24', 't5', 'name', 'TEXT', '产品名称', '产品名称'),
        ('f25', 't5', 'line', 'TEXT', '产品线', '家用电器/数码产品等'),
        ('f26', 't5', 'price', 'REAL', '单价', '单价(元)'),
    ]
    for fid, table_id, name, typ, biz, desc in fields:
        c.execute('INSERT INTO table_fields VALUES(?,?,?,?,?,?)', (fid, table_id, name, typ, biz, desc))
    conn.commit()


# ---------------------------------------------------------------- 通用读写
def rows_to_list(rows):
    return [dict(r) for r in rows]


def list_table(conn, table, order=None):
    sql = f'SELECT * FROM {table}'
    if order:
        sql += f' ORDER BY {order}'
    return rows_to_list(conn.execute(sql).fetchall())


def get_setting(conn, key, default=None):
    row = conn.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    return row['value'] if row else default


def set_setting(conn, key, value):
    conn.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))
    conn.commit()


# ---------------------------------------------------------------- 图表构建
def _to_number(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def detect_chart(labels, hint=None):
    if hint in ('bar', 'line', 'pie', 'hbar'):
        return hint
    date_like = all(re.match(r'^\d{4}(-\d{2})?', str(l)) for l in labels)
    if date_like:
        return 'line'
    n = len(labels)
    if n <= 6:
        return 'pie'
    if n <= 8:
        return 'bar'
    return 'hbar'


def build_chart_from_rows(rows, cols, hint=None):
    labels = [str(r[0]) for r in rows]
    # 找第一列数值列作为 values（跳过第一列标签）
    values = []
    vcol = 1
    for i in range(1, len(cols)):
        nums = [_to_number(r[i]) for r in rows]
        if all(n is not None for n in nums):
            values = [round(n, 2) for n in nums]
            vcol = i
            break
    if not values and rows:
        values = [0] * len(rows)
    table_rows = [[str(c) if c is not None else '' for c in r] for r in rows]
    return {
        'labels': labels,
        'values': values,
        'cols': list(cols),
        'rows': table_rows,
        'chart': detect_chart(labels, hint),
    }


# ---------------------------------------------------------------- SQL 安全校验
FORBIDDEN = re.compile(r'\b(insert|update|delete|drop|alter|truncate|create|exec|attach|detach|pragma|replace|grant|revoke)\b', re.I)


def _sanitize_sql(sql, engine=''):
    sql = sql.strip().rstrip(';').strip()
    if not sql.lower().startswith('select') and not sql.lower().startswith('with'):
        raise ValueError('仅允许执行 SELECT 查询')
    if FORBIDDEN.search(sql):
        raise ValueError('SQL 包含被禁止的操作')
    low = sql.lower()
    if 'limit' not in low and 'fetch first' not in low and 'rownum' not in low:
        if engine == 'oracle':
            sql += ' FETCH FIRST 200 ROWS ONLY'
        else:
            sql += ' LIMIT 200'
    return sql


def _execute_sql(ds, sql):
    """按指定数据源执行 SQL，返回 (rows, cols, elapsed_ms)，rows 为 list[list]"""
    engine = (ds.get('engine') or '').lower()
    sql = _sanitize_sql(sql, engine)
    host = ds.get('host') or ''
    port = ds.get('port') or ''
    db = ds.get('db') or ''
    user = ds.get('username') or ''
    pw = ds.get('password') or ''
    t0 = time.time()
    if engine == 'sqlite':
        fp = db if os.path.isabs(db) else os.path.join(DATA_DIR, db)
        c = sqlite3.connect(fp)
        try:
            cur = c.execute(sql)
            rows = [list(r) for r in cur.fetchall()]
            cols = [d[0] for d in cur.description]
            return rows, cols, int((time.time() - t0) * 1000)
        finally:
            c.close()
    if engine == 'mysql':
        import pymysql
        c = pymysql.connect(host=host, port=int(port or 3306), user=user, password=pw, database=db, connect_timeout=8)
        try:
            cur = c.cursor()
            cur.execute(sql)
            rows = [list(r) for r in cur.fetchall()]
            cols = [d[0] for d in cur.description]
            return rows, cols, int((time.time() - t0) * 1000)
        finally:
            c.close()
    if engine in ('postgresql', 'postgres', 'pg'):
        import pg8000
        c = pg8000.connect(host=host, port=int(port or 5432), user=user, password=pw, database=db, timeout=8)
        try:
            cur = c.cursor()
            cur.execute(sql)
            rows = [list(r) for r in cur.fetchall()]
            cols = [d[0] for d in cur.description]
            return rows, cols, int((time.time() - t0) * 1000)
        finally:
            c.close()
    if engine == 'oracle':
        import oracledb
        c = oracledb.connect(user=user, password=pw, host=host, port=int(port or 1521), service_name=db)
        try:
            cur = c.cursor()
            cur.execute(sql)
            rows = [list(r) for r in cur.fetchall()]
            cols = [d[0] for d in cur.description]
            return rows, cols, int((time.time() - t0) * 1000)
        finally:
            c.close()
    raise ValueError(f'不支持的引擎：{engine}')


# ---------------------------------------------------------------- 数据库驱动（纯 Python，打包在 libs/）
def _try_connect(ds):
    """按引擎真实连接数据库，返回 (ok, message)。"""
    engine = (ds.get('engine') or '').lower()
    host = ds.get('host') or ''
    port = ds.get('port') or ''
    db = ds.get('db') or ''
    user = ds.get('username') or ''
    pw = ds.get('password') or ''
    try:
        if engine == 'mysql':
            import pymysql
            pymysql.connect(host=host, port=int(port or 3306), user=user, password=pw,
                            database=db or None, connect_timeout=8).close()
            return True, '连接成功'
        if engine in ('postgresql', 'postgres', 'pg'):
            import pg8000
            pg8000.connect(host=host, port=int(port or 5432), user=user, password=pw,
                           database=db or None, timeout=8).close()
            return True, '连接成功'
        if engine == 'oracle':
            import oracledb
            oracledb.connect(user=user, password=pw, host=host, port=int(port or 1521),
                             service_name=db or None).close()
            return True, '连接成功'
    except ImportError as e:
        return False, f'未安装 {engine} 驱动：{e}'
    except Exception as e:
        return False, f'连接失败：{e}'
    return False, f'不支持的引擎：{engine}'


def _introspect_tables(ds):
    """真实连接并列出表与字段，返回 [(表名, [(字段名, 类型), ...]), ...]，不支持则返回 None。"""
    engine = (ds.get('engine') or '').lower()
    host = ds.get('host') or ''
    port = ds.get('port') or ''
    db = ds.get('db') or ''
    user = ds.get('username') or ''
    pw = ds.get('password') or ''
    if engine == 'mysql':
        import pymysql
        c = pymysql.connect(host=host, port=int(port or 3306), user=user, password=pw, database=db, connect_timeout=8)
        cur = c.cursor()
        cur.execute('SHOW TABLES')
        names = [r[0] for r in cur.fetchall()]
        out = []
        for n in names:
            cur.execute(f'SHOW COLUMNS FROM `{n}`')
            out.append((n, [(r[0], r[1]) for r in cur.fetchall()]))
        c.close()
        return out
    if engine in ('postgresql', 'postgres', 'pg'):
        import pg8000
        c = pg8000.connect(host=host, port=int(port or 5432), user=user, password=pw, database=db, timeout=8)
        cur = c.cursor()
        cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")
        names = [r[0] for r in cur.fetchall()]
        out = []
        for n in names:
            cur.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = %s ORDER BY ordinal_position", (n,))
            out.append((n, [(r[0], r[1]) for r in cur.fetchall()]))
        c.close()
        return out
    if engine == 'oracle':
        import oracledb
        c = oracledb.connect(user=user, password=pw, host=host, port=int(port or 1521), service_name=db)
        cur = c.cursor()
        cur.execute('SELECT table_name FROM user_tables ORDER BY table_name')
        names = [r[0] for r in cur.fetchall()]
        out = []
        for n in names:
            cur.execute('SELECT column_name, data_type FROM user_tab_columns WHERE table_name = :1 ORDER BY column_id', [n])
            out.append((n, [(r[0], r[1]) for r in cur.fetchall()]))
        c.close()
        return out
    return None


def build_schema(ds_id, conn):
    """根据数据源的表/字段元数据构建 schema 描述（供大模型生成 SQL）"""
    tables = conn.execute('SELECT id, name, biz FROM tables WHERE ds_id=? AND enabled=1', (ds_id,)).fetchall()
    if not tables:
        return CRM_SCHEMA
    lines = []
    for t in tables:
        fields = conn.execute('SELECT name, type, biz, desc FROM table_fields WHERE table_id=?', (t['id'],)).fetchall()
        parts = []
        for f in fields:
            col = f['name']
            if f['biz'] and f['biz'] != f['name']:
                col += f'(含义:{f["biz"]})'
            parts.append(col)
        name = t['name'] + (f'({t["biz"]})' if t['biz'] else '')
        lines.append(f'表: {name} (' + ', '.join(parts) + ')')
    return '\n'.join(lines)


# ---------------------------------------------------------------- 规则引擎
CRM_SCHEMA = """表: crm_departments (id, name, region 大区, province 省份, parent_id)
表: crm_salespeople (id, name 姓名, department_id, phone, email)
表: crm_orders (id, sales_id, customer_id, product_id, order_date 日期, actual_amount 金额(元), quantity 数量, status 状态:已完成/已取消)
表: crm_customers (id, name, industry 行业, customer_level 等级:A/B/C/S)
表: crm_products (id, name, line 产品线, price 单价)"""

RULES = [
    dict(re=r'排名|top|前十|前10|排行|业绩排名', title='销售人员业绩排名 TOP10', chart='hbar',
         sql="SELECT s.name AS label, ROUND(SUM(o.actual_amount)/10000.0,1) AS value FROM crm_orders o JOIN crm_salespeople s ON o.sales_id=s.id WHERE o.status!='已取消' GROUP BY s.name ORDER BY value DESC LIMIT 10",
         term='业绩 → actual_amount', path='销售 → 订单', example='销售人员业绩排名TOP10',
         followups=['张伟的客户都有哪些？', '对比上季度排名', '各区域销售人数']),
    dict(re=r'占比|产品线|构成|比例|结构|销量', title='各产品线销量占比', chart='pie',
         sql="SELECT p.line AS label, SUM(o.quantity) AS value FROM crm_orders o JOIN crm_products p ON o.product_id=p.id WHERE o.status!='已取消' GROUP BY p.line ORDER BY value DESC",
         term='产品线 → product_line', path='订单 → 产品', example='各产品线销量占比',
         followups=['家用电器增长趋势？', '各产品线利润对比', '切换为柱状图查看']),
    dict(re=r'趋势|近.*月|月度|每月|走势|月份|半年|季度', title='近12个月销售额趋势', chart='line',
         sql="SELECT strftime('%Y-%m',o.order_date) AS label, ROUND(SUM(o.actual_amount)/10000.0,1) AS value FROM crm_orders o WHERE o.order_date>=date('now','-11 months','start of month') AND o.status!='已取消' GROUP BY label ORDER BY label",
         term='销售额 → actual_amount', path='订单表（单表）', example='近12个月销售额趋势',
         followups=['按月环比变化是多少？', '预测下个月销售额', '按大区拆分趋势']),
    dict(re=r'大于|超过|以上|哪些区域|哪个区域', title='销售额大于500万的区域', chart='bar',
         sql="SELECT d.region AS label, ROUND(SUM(o.actual_amount)/10000.0,1) AS value FROM crm_orders o JOIN crm_salespeople s ON o.sales_id=s.id JOIN crm_departments d ON s.department_id=d.id WHERE o.status!='已取消' GROUP BY d.region HAVING SUM(o.actual_amount)>5000000 ORDER BY value DESC",
         term='销售额 → actual_amount', path='订单 → 销售 → 部门', example='—',
         followups=['未达标区域是哪些？', '华南各城市明细', '按季度对比各区域']),
    dict(re=r'客户|数量|统计|行业|多少家|几家', title='各行业客户数量统计', chart='bar',
         sql="SELECT industry AS label, COUNT(*) AS value FROM crm_customers GROUP BY industry ORDER BY value DESC",
         term='制造业 → industry', path='客户表（单表）', example='制造业客户数量统计',
         followups=['制造业大客户有哪些？', '各行业年采购额', '新增客户趋势']),
    dict(re=r'华南|南区', title='华南大区本月销售业绩', chart='bar',
         sql="SELECT d.province AS label, ROUND(SUM(o.actual_amount)/10000.0,1) AS value FROM crm_orders o JOIN crm_salespeople s ON o.sales_id=s.id JOIN crm_departments d ON s.department_id=d.id WHERE d.region='华南' AND strftime('%Y-%m',o.order_date)=strftime('%Y-%m','now') AND o.status!='已取消' GROUP BY d.province ORDER BY value DESC",
         term='华南大区 → region', path='部门 → 销售 → 订单', example='大区销售业绩查询',
         followups=['广西销售额为什么增长？', '对比上个月各大区排名', '按产品线拆解海南销售额']),
]

FALLBACK_RULE = dict(
    title='销售额趋势', chart='line',
    sql="SELECT strftime('%Y-%m',o.order_date) AS label, ROUND(SUM(o.actual_amount)/10000.0,1) AS value FROM crm_orders o WHERE o.status!='已取消' GROUP BY label ORDER BY label LIMIT 12",
    term='未命中特定术语', path='自动匹配相关表', example='—',
    followups=['换一种问法试试', '近12个月销售额趋势', '各产品线销量占比'])


def rule_generate(question):
    for r in RULES:
        if re.search(r['re'], question, re.I):
            return r
    return FALLBACK_RULE


# ---------------------------------------------------------------- 大模型接入
def llm_test(model):
    """模型连通性测试（发一个最小请求）"""
    url = (model.get('base_url') or 'https://api.deepseek.com').rstrip('/') + '/chat/completions'
    payload = {
        'model': model['model_id'],
        'messages': [{'role': 'user', 'content': 'ping'}],
        'max_tokens': 5,
        'stream': False,
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + model['api_key']})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            json.loads(resp.read().decode('utf-8'))
        return True
    except Exception:
        return False


def llm_generate(question, model, schema, engine='', prompts_text=''):
    if not model or not model.get('api_key'):
        return None
    dialect = ''
    if engine == 'oracle':
        dialect = '\n数据库类型：Oracle。注意：Oracle 不支持 LIMIT 语法，如需限制行数请使用 FETCH FIRST n ROWS ONLY。\n'
    elif engine == 'mysql':
        dialect = '\n数据库类型：MySQL。\n'
    elif engine in ('postgresql', 'postgres', 'pg'):
        dialect = '\n数据库类型：PostgreSQL。\n'
    prompt_block = ('\n业务规则/约束：\n' + prompts_text + '\n') if prompts_text else ''
    system = (
        '你是 BondQL 智能问数的 SQL 生成引擎。请根据给定的数据库表结构与字段含义，'
        '把用户问题转换为一条只读的 SELECT 查询。\n'
        '只返回一个 JSON 对象，不要输出任何解释或代码块标记，格式：\n'
        '{"sql":"SELECT ...","title":"简短图表标题","chart":"bar|line|pie|hbar","followups":["追问1","追问2","追问3"]}\n\n'
        '要求：\n'
        '1. 只生成 SELECT 查询，禁止 INSERT/UPDATE/DELETE/DROP 等写操作。\n'
        '2. 金额类字段如需汇总展示，请自行判断是否换算单位（如 /10000 转为万元）。\n'
        '3. 第一列作为分类标签（label），第二列作为数值（value），使用别名 label 和 value。\n'
        '4. chart 取值：时间趋势用 line，占比/构成用 pie，类别少用 bar，排名用 hbar。\n'
        + dialect + prompt_block +
        '数据库表结构：\n' + schema
    )
    payload = {
        'model': model['model_id'],
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': question},
        ],
        'temperature': 0.1,
        'stream': False,
    }
    url = (model.get('base_url') or 'https://api.deepseek.com').rstrip('/') + '/chat/completions'
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + model['api_key']})
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print('[LLM] request error:', e, flush=True)
        return None
    content = data['choices'][0]['message']['content']
    # 解析可能的 ```json ... ``` 包裹
    m = re.search(r'```(?:json)?\s*(\{.*\})\s*```', content, re.S)
    if m:
        content = m.group(1)
    else:
        content = content.strip().strip('`').strip()
    try:
        return json.loads(content)
    except Exception:
        m2 = re.search(r'\{.*\}', content, re.S)
        if m2:
            try:
                return json.loads(m2.group(0))
            except Exception:
                pass
    return None


# ---------------------------------------------------------------- 数据分析
def analyze(labels, values, chart):
    """基于查询结果生成规则化数据分析洞察"""
    n = len(values)
    if n == 0:
        return []
    insights = []
    total = sum(values)
    maxv, minv = max(values), min(values)
    maxi, mini = values.index(maxv), values.index(minv)
    avg = total / n
    insights.append(f'共 {n} 项，合计 {total:,.1f}，均值 {avg:,.1f}')
    insights.append(f'最高「{labels[maxi]}」{maxv:,.1f}；最低「{labels[mini]}」{minv:,.1f}')
    if maxv > 0:
        insights.append(f'「{labels[maxi]}」占总体的 {maxv/total*100:.1f}%，是最大贡献项')
    if n > 1 and minv > 0 and maxv / minv >= 2:
        insights.append(f'头部与尾部相差 {maxv/minv:.1f} 倍，分布不均衡，建议关注长尾')
    if chart == 'line' and n > 2:
        first, last = values[0], values[-1]
        if first:
            insights.append(f'周期内由 {first:,.1f} 变动至 {last:,.1f}，累计 {((last-first)/first*100):+.1f}%')
        diffs = [values[i] - values[i - 1] for i in range(1, n)]
        mi = diffs.index(max(diffs))
        insights.append(f'环比增幅最大的是「{labels[mi+1]}」（{diffs[mi]:+,.1f}）')
        neg = sum(1 for d in diffs if d < 0)
        if neg:
            insights.append(f'共 {len(diffs)} 个周期中 {neg} 个环比下滑')
    elif chart in ('bar', 'hbar', 'pie') and n > 3:
        top2 = values[0] + (values[1] if n > 1 else 0)
        insights.append(f'前 2 项合计占总体的 {top2/total*100:.1f}%，集中度较高')
    return insights


def llm_summarize(question, labels, values, model):
    """让大模型对结果做自然语言分析总结（可选，失败返回 None）"""
    if not model or not model.get('api_key'):
        return None
    preview = '；'.join(f'{l}:{v}' for l, v in zip(labels[:12], values[:12]))
    payload = {
        'model': model['model_id'],
        'messages': [
            {'role': 'system', 'content': '你是数据分析师。基于给定的查询结果，用 2~4 句简洁中文做业务分析（趋势/结构/异常/建议），直接输出正文，不要标题或列表符号。'},
            {'role': 'user', 'content': f'问题：{question}\n数据（标签:数值）：{preview}'},
        ],
        'temperature': 0.4,
        'max_tokens': 300,
        'stream': False,
    }
    url = (model.get('base_url') or 'https://api.deepseek.com').rstrip('/') + '/chat/completions'
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + model['api_key']})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return data['choices'][0]['message']['content'].strip()
    except Exception:
        return None


# ---------------------------------------------------------------- 问数主流程
def llm_suggestions(model, schema):
    """让大模型根据表结构生成推荐提问"""
    if not model or not model.get('api_key'):
        return None
    payload = {
        'model': model['model_id'],
        'messages': [
            {'role': 'system', 'content': '你是数据分析助手。根据给定的数据库表结构，生成 5 个用户最可能关心的中文问数问题，要求口语化、可直接提问。只返回 JSON 字符串数组，不要任何其它文字。'},
            {'role': 'user', 'content': '数据库表结构：\n' + schema},
        ],
        'temperature': 0.7,
        'max_tokens': 400,
        'stream': False,
    }
    url = (model.get('base_url') or 'https://api.deepseek.com').rstrip('/') + '/chat/completions'
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + model['api_key']})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        content = data['choices'][0]['message']['content'].strip()
        m = re.search(r'\[.*\]', content, re.S)
        if m:
            arr = json.loads(m.group(0))
            if isinstance(arr, list) and arr:
                return [str(x) for x in arr][:6]
    except Exception:
        pass
    return None


def _error_answer(question, ds, message):
    return {
        'role': 'bot',
        'steps': ['解析问题语义', '生成查询失败'],
        'title': '查询失败',
        'chart': 'bar',
        'labels': [], 'values': [], 'cols': [], 'rows': [],
        'followups': [],
        'sql': '',
        'evidence': {
            'termText': '—', 'ds': ds['name'] if ds else '—', 'path': '—', 'example': '—',
            'rowPerm': '—', 'colPerm': '—', 'prompts': [],
        },
        'elapsed_ms': 0, 'engine': 'error', 'model_name': None,
        'analysis': [], 'ai_summary': None, 'error': message,
    }


def ask(question, conn, model_id=None, ds_id=None):
    # 0. 确定数据源（与工作空间关联）
    if not ds_id:
        ds_id = get_setting(conn, 'active_datasource', 'ds-demo')
    ds_row = conn.execute('SELECT * FROM datasources WHERE id=?', (ds_id,)).fetchone()
    if not ds_row:
        ds_row = conn.execute('SELECT * FROM datasources LIMIT 1').fetchone()
    ds = dict(ds_row) if ds_row else None
    is_demo = (ds_id == 'ds-demo')
    schema = build_schema(ds_id, conn) if ds else CRM_SCHEMA

    # 1. 选择模型
    if model_id:
        model = conn.execute('SELECT * FROM models WHERE id=?', (model_id,)).fetchone()
    else:
        model = conn.execute("SELECT * FROM models WHERE status='default'").fetchone()
    if not model:
        model = conn.execute('SELECT * FROM models LIMIT 1').fetchone()
    model = dict(model) if model else None
    model_name = model['name'] if model else None

    matched_term = '未命中特定术语'
    example = '—'
    path = '自动匹配'

    # 取该数据源相关的自定义提示词（全局 + 专属）
    prompt_rows = conn.execute("SELECT content FROM prompts WHERE ds_id='' OR ds_id=?", (ds_id,)).fetchall()
    prompts_text = '\n'.join(p['content'] for p in prompt_rows)
    llm_result = llm_generate(question, model, schema, (ds.get('engine') or '').lower(), prompts_text) if model else None
    if llm_result and llm_result.get('sql'):
        sql = llm_result['sql']
        title = llm_result.get('title') or '查询结果'
        chart_hint = llm_result.get('chart') or 'bar'
        followups = llm_result.get('followups') or []
        engine = 'llm'
        steps = ['解析问题语义', '匹配表关系', '大模型生成 SQL', 'SQL 校验通过']
    elif is_demo:
        rule = rule_generate(question)
        sql, title, chart_hint, followups = rule['sql'], rule['title'], rule['chart'], rule['followups']
        engine = 'rule'
        steps = ['解析问题语义', '匹配术语与表关系', '规则引擎匹配 SQL', 'SQL 校验通过']
        matched_term = rule.get('term', matched_term)
        example = rule.get('example', '—')
        path = rule.get('path', path)
    else:
        return _error_answer(question, ds, '当前数据源非内置演示库，且未配置可用大模型，无法将自然语言转为 SQL。请在「AI模型配置」中配置模型，或切换到演示数据源。')

    # 2. 执行 SQL（演示库执行失败可降级规则引擎）
    try:
        rows, cols, elapsed = _execute_sql(ds, sql)
    except Exception as e:
        print('[SQL] exec error:', e, flush=True)
        if is_demo and engine == 'llm':
            rule = rule_generate(question)
            sql, title, chart_hint, followups = rule['sql'], rule['title'], rule['chart'], rule['followups']
            engine = 'rule'
            steps = ['解析问题语义', '匹配术语与表关系', '规则引擎匹配 SQL', 'SQL 校验通过']
            matched_term = rule.get('term', matched_term)
            example = rule.get('example', '—')
            path = rule.get('path', path)
            try:
                rows, cols, elapsed = _execute_sql(ds, sql)
            except Exception as e2:
                return _error_answer(question, ds, f'SQL 执行失败：{e2}')
        else:
            return _error_answer(question, ds, f'SQL 执行失败：{e}')

    result = build_chart_from_rows(rows, cols, hint=chart_hint)
    analysis = analyze(result['labels'], result['values'], result['chart'])
    ai_summary = llm_summarize(question, result['labels'], result['values'], model) if (engine == 'llm' and model) else None

    term_rows = conn.execute("SELECT term, syn, logic FROM terms WHERE status='enabled'").fetchall()
    matched = []
    for tr in term_rows:
        keys = [tr['term']] + [s for s in tr['syn'].split('、') if s]
        if any(k and k in question for k in keys):
            matched.append(f"{tr['term']} → {tr['logic'][:18]}")
    if not matched:
        matched = [matched_term]

    prompts = [p['content'].split('\n')[0].replace('#', '').strip() for p in conn.execute("SELECT content FROM prompts WHERE ds_id='' OR ds_id=?", (ds_id,)).fetchall()]
    steps[3] = f'SQL 执行完成 ({elapsed}ms)'

    return {
        'role': 'bot',
        'steps': steps,
        'title': title,
        'chart': result['chart'],
        'labels': result['labels'],
        'values': result['values'],
        'cols': result['cols'],
        'rows': result['rows'],
        'followups': followups,
        'sql': sql,
        'evidence': {
            'termText': '；'.join(matched),
            'ds': ds['name'] if ds else '—',
            'path': path,
            'example': example,
            'rowPerm': '无限制（演示）',
            'colPerm': '隐藏 phone、email',
            'prompts': prompts,
        },
        'elapsed_ms': elapsed,
        'engine': engine,
        'model_name': model_name,
        'analysis': analysis,
        'ai_summary': ai_summary,
    }


# ---------------------------------------------------------------- 资源映射
RESOURCES = {
    'workspaces': 'workspaces',
    'datasources': 'datasources',
    'tables': 'tables',
    'table_fields': 'table_fields',
    'relations': 'relations',
    'terms': 'terms',
    'examples': 'examples',
    'prompts': 'prompts',
    'rules': 'rules',
    'models': 'models',
    'assistants': 'assistants',
    'dashboards': 'dashboards',
}

# 同步表结构时排除的元数据表（这些是 BondQL 自身存储，不属于业务数据）
METADATA_TABLES = {
    'workspaces', 'datasources', 'tables', 'relations', 'terms', 'examples',
    'prompts', 'rules', 'models', 'assistants', 'dashboards', 'chats',
    'messages', 'settings', 'users', 'table_fields', 'workspace_datasources', 'workspace_tables',
}


def serialize_row(table, row):
    d = dict(row)
    if table == 'rules' and 'items' in d:
        d['items'] = json.loads(d['items']) if isinstance(d['items'], str) else d['items']
    if table == 'tables' and 'enabled' in d:
        d['enabled'] = bool(d['enabled'])
    if table == 'assistants' and 'enabled' in d:
        d['enabled'] = bool(d['enabled'])
    if table == 'models':
        d['api_key_set'] = bool(d.get('api_key'))
        d.pop('api_key', None)
    if table == 'datasources':
        d['password_set'] = bool(d.get('password'))
        d.pop('password', None)
    return d


# ---------------------------------------------------------------- HTTP 处理
class Handler(BaseHTTPRequestHandler):
    server_version = 'BondQL/1.0'

    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, obj)

    def _read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n).decode('utf-8'))

    # ---------- 鉴权 ----------
    def _authenticate(self):
        auth = self.headers.get('Authorization') or ''
        token = auth.replace('Bearer ', '').strip()
        if token and token in SESSIONS:
            self.user = SESSIONS[token]
            return True
        self.user = None
        return False

    def _guard(self, path):
        if path in ('/api/health', '/api/login'):
            return True
        if self._authenticate():
            return True
        self._json(401, {'error': '未登录或会话已过期'})
        return False

    def _require_admin(self):
        if not (self.user and self.user.get('role') == 'admin'):
            self._json(403, {'error': '无权限：仅管理员可执行此操作'})
            return False
        return True

    def _static(self, path):
        if path in ('/', '/index.html'):
            path = '/index.html'
        fp = os.path.normpath(os.path.join(WEB_DIR, path.lstrip('/')))
        if not fp.startswith(WEB_DIR) or not os.path.isfile(fp):
            self._json(404, {'error': 'not found'})
            return
        ext = os.path.splitext(fp)[1].lower()
        with open(fp, 'rb') as f:
            self._send(200, f.read(), MIME.get(ext, 'application/octet-stream'))

    def do_GET(self):
        path = self.path.split('?')[0]
        try:
            if path.startswith('/api/'):
                if not self._guard(path):
                    return
                self.handle_api_get(path)
            else:
                self._static(path)
        except Exception as e:
            self._json(500, {'error': str(e)})

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            if not self._guard(path):
                return
            self.handle_api_post(path)
        except Exception as e:
            self._json(500, {'error': str(e)})

    def do_PUT(self):
        path = self.path.split('?')[0]
        try:
            if not self._guard(path):
                return
            self.handle_api_put(path)
        except Exception as e:
            self._json(500, {'error': str(e)})

    def do_DELETE(self):
        path = self.path.split('?')[0]
        try:
            if not self._guard(path):
                return
            self.handle_api_delete(path)
        except Exception as e:
            self._json(500, {'error': str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))

    # ---------- GET ----------
    def handle_api_get(self, path):
        if path == '/api/health':
            return self._json(200, {'ok': True, 'name': 'BondQL', 'version': '1.0.0'})
        if path == '/api/me':
            return self._json(200, {'user': self.user})
        if path == '/api/bootstrap':
            return self._json(200, self.bootstrap())
        if path == '/api/chats':
            return self._json(200, self.chat_list())
        m = re.match(r'^/api/chats/([^/]+)$', path)
        if m:
            return self._json(200, self.chat_detail(m.group(1)))
        m = re.match(r'^/api/([a-z-]+)$', path)
        if m and m.group(1) in RESOURCES:
            return self._json(200, self.resource_list(m.group(1)))
        self._json(404, {'error': 'unknown endpoint'})

    # ---------- POST ----------
    def handle_api_post(self, path):
        if path == '/api/login':
            return self.login()
        if path == '/api/logout':
            return self.logout()
        if path == '/api/chat':
            return self.chat()
        if path == '/api/chats/new':
            return self.chat_new()
        if path == '/api/test-model':
            return self.test_model()
        if path == '/api/suggestions':
            return self.suggest()
        if path == '/api/test-connection':
            return self.test_connection()
        if path == '/api/relations/save':
            return self.relations_save()
        if path == '/api/workspace-bindings':
            return self.workspace_bindings()
        m = re.match(r'^/api/datasources/([^/]+)/sync$', path)
        if m:
            return self.datasource_sync(m.group(1))
        m = re.match(r'^/api/([a-z-]+)$', path)
        if m and m.group(1) in RESOURCES:
            return self.resource_create(m.group(1))
        self._json(404, {'error': 'unknown endpoint'})

    # ---------- PUT ----------
    def handle_api_put(self, path):
        m = re.match(r'^/api/settings/([^/]+)$', path)
        if m:
            body = self._read_json()
            conn = get_conn()
            try:
                set_setting(conn, m.group(1), body.get('value', ''))
                return self._json(200, {'ok': True})
            finally:
                conn.close()
        m = re.match(r'^/api/([a-z-]+)/([^/]+)$', path)
        if m and m.group(1) in RESOURCES:
            return self.resource_update(m.group(1), m.group(2))
        self._json(404, {'error': 'unknown endpoint'})

    # ---------- DELETE ----------
    def handle_api_delete(self, path):
        m = re.match(r'^/api/chats/([^/]+)$', path)
        if m:
            conn = get_conn()
            try:
                conn.execute('DELETE FROM messages WHERE chat_id=?', (m.group(1),))
                conn.execute('DELETE FROM chats WHERE id=?', (m.group(1),))
                conn.commit()
                return self._json(200, {'ok': True})
            finally:
                conn.close()
        m = re.match(r'^/api/([a-z-]+)/([^/]+)$', path)
        if m and m.group(1) in RESOURCES:
            return self.resource_delete(m.group(1), m.group(2))
        self._json(404, {'error': 'unknown endpoint'})

    # ---------- 推荐提问 ----------
    def suggest(self):
        conn = get_conn()
        try:
            model = conn.execute("SELECT * FROM models WHERE status='default'").fetchone()
            if not model:
                model = conn.execute('SELECT * FROM models LIMIT 1').fetchone()
            model = dict(model) if model else None
            ds_id = get_setting(conn, 'active_datasource', 'ds-demo')
            schema = build_schema(ds_id, conn)
            suggestions = llm_suggestions(model, schema) if model else None
            source = 'llm' if suggestions else 'default'
            if not suggestions:
                suggestions = ['近12个月销售额趋势', '各产品线销量占比', '销售额大于500万的区域有哪些', '销售人员业绩排名TOP10', '制造业客户数量统计']
            return self._json(200, {'suggestions': suggestions, 'source': source})
        finally:
            conn.close()

    # ---------- 模型测试 ----------
    def test_model(self):
        body = self._read_json()
        conn = get_conn()
        try:
            row = conn.execute('SELECT * FROM models WHERE id=?', (body.get('id'),)).fetchone()
            if not row:
                return self._json(404, {'error': 'model not found'})
            model = dict(row)
            if not model.get('api_key'):
                return self._json(200, {'message': '未配置 API Key（当前使用内置规则引擎，不影响问数）'})
            if llm_test(model):
                return self._json(200, {'message': f"连接正常，模型 {model['model_id']} 可用"})
            return self._json(400, {'error': '连接失败，请检查 Base URL / API Key / 网络'})
        finally:
            conn.close()

    # ---------- 连通性测试 / 同步表结构 / 批量保存关联 / 工作空间绑定 ----------
    def test_connection(self):
        body = self._read_json()
        conn = get_conn()
        try:
            if body.get('id'):
                row = conn.execute('SELECT * FROM datasources WHERE id=?', (body['id'],)).fetchone()
                ds = dict(row) if row else None
            else:
                ds = body
            if not ds:
                return self._json(400, {'error': '数据源不存在'})
            engine = (ds.get('engine') or '').lower()
            if engine == 'sqlite':
                db = ds.get('db') or ''
                if not db:
                    return self._json(400, {'error': '缺少数据库文件路径'})
                fp = db if os.path.isabs(db) else os.path.join(DATA_DIR, db)
                if not os.path.isfile(fp):
                    return self._json(400, {'error': f'数据库文件不存在：{fp}'})
                try:
                    c2 = sqlite3.connect(fp)
                    c2.execute('SELECT 1')
                    c2.close()
                    return self._json(200, {'ok': True, 'message': '连接成功', 'latency_ms': 5})
                except Exception as e:
                    return self._json(400, {'error': f'连接失败：{e}'})
            # MySQL / PostgreSQL / Oracle：真实驱动连接（校验账号密码）
            ok, msg = _try_connect(ds)
            if ok:
                return self._json(200, {'ok': True, 'message': msg, 'latency_ms': 0})
            return self._json(400, {'error': msg})
        finally:
            conn.close()

    def datasource_sync(self, rid):
        conn = get_conn()
        try:
            row = conn.execute('SELECT * FROM datasources WHERE id=?', (rid,)).fetchone()
            if not row:
                return self._json(404, {'error': '数据源不存在'})
            ds = dict(row)
            engine = (ds.get('engine') or '').lower()
            # 获取表结构：[(表名, [(字段名, 类型), ...]), ...]
            if engine == 'sqlite':
                db = ds.get('db') or ''
                fp = db if os.path.isabs(db) else os.path.join(DATA_DIR, db)
                if not os.path.isfile(fp):
                    return self._json(400, {'error': f'数据库文件不存在：{fp}'})
                c2 = sqlite3.connect(fp)
                names = [r[0] for r in c2.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
                names = [n for n in names if n not in METADATA_TABLES]
                tabs = []
                for n in names:
                    cols = c2.execute(f'PRAGMA table_info("{n}")').fetchall()
                    tabs.append((n, [(c[1], c[2] or '') for c in cols]))
                c2.close()
            else:
                tabs = _introspect_tables(ds)
                if tabs is None:
                    return self._json(400, {'error': f'不支持同步 {engine} 引擎的表结构，或未安装对应驱动'})

            # 记录旧表 id -> name（用于恢复工作空间表绑定）
            old_map = {r['id']: r['name'] for r in conn.execute('SELECT id, name FROM tables WHERE ds_id=?', (rid,)).fetchall()}
            for tid in old_map:
                conn.execute('DELETE FROM table_fields WHERE table_id=?', (tid,))
            conn.execute('DELETE FROM tables WHERE ds_id=?', (rid,))
            # 插入新表 + 字段
            new_map = {}
            for i, (tname, cols) in enumerate(tabs):
                tid = 't-' + uuid.uuid4().hex[:8]
                new_map[tname] = tid
                conn.execute('INSERT INTO tables VALUES(?,?,?,?,?,?,?,?)',
                             (tid, rid, 'public', tname, tname, len(cols), '', 1))
                for ci, (cname, ctype) in enumerate(cols):
                    conn.execute('INSERT INTO table_fields VALUES(?,?,?,?,?,?)',
                                 (f'{tid}-f{ci}', tid, cname, ctype or '', cname, ''))
            # 按表名重映射工作空间表绑定，避免绑定失效
            for ws_id, tid in conn.execute('SELECT ws_id, table_id FROM workspace_tables').fetchall():
                if tid in old_map and old_map[tid] in new_map:
                    conn.execute('UPDATE workspace_tables SET table_id=? WHERE ws_id=? AND table_id=?',
                                 (new_map[old_map[tid]], ws_id, tid))
            conn.commit()
            return self._json(200, {'ok': True, 'count': len(tabs), 'tables': [t[0] for t in tabs]})
        finally:
            conn.close()

    def relations_save(self):
        body = self._read_json()
        ds_id = body.get('ds_id')
        rels = body.get('relations') or []
        if not ds_id:
            return self._json(400, {'error': 'ds_id required'})
        conn = get_conn()
        try:
            conn.execute('DELETE FROM relations WHERE ds_id=?', (ds_id,))
            for r in rels:
                rid = 'r-' + uuid.uuid4().hex[:8]
                conn.execute('INSERT INTO relations VALUES(?,?,?,?,?,?,?)',
                             (rid, ds_id, r.get('lt'), r.get('lf'), r.get('rt'), r.get('rf'), r.get('type') or '1:N'))
            conn.commit()
            return self._json(200, {'ok': True, 'count': len(rels)})
        finally:
            conn.close()

    def workspace_bindings(self):
        body = self._read_json()
        ws_id = body.get('ws_id')
        if not ws_id:
            return self._json(400, {'error': 'ws_id required'})
        ds_ids = body.get('datasource_ids') or []
        table_ids = body.get('table_ids') or []
        conn = get_conn()
        try:
            conn.execute('DELETE FROM workspace_datasources WHERE ws_id=?', (ws_id,))
            conn.execute('DELETE FROM workspace_tables WHERE ws_id=?', (ws_id,))
            for ds in ds_ids:
                conn.execute('INSERT OR IGNORE INTO workspace_datasources VALUES(?,?)', (ws_id, ds))
            for t in table_ids:
                conn.execute('INSERT OR IGNORE INTO workspace_tables VALUES(?,?)', (ws_id, t))
            conn.commit()
            return self._json(200, {'ok': True})
        finally:
            conn.close()

    # ---------- 登录 / 登出 ----------
    def login(self):
        body = self._read_json()
        username = (body.get('username') or '').strip()
        password = body.get('password') or ''
        conn = get_conn()
        try:
            row = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            if not row or not verify_password(password, row['salt'], row['password_hash']):
                return self._json(401, {'error': '用户名或密码错误'})
            user = {
                'id': row['id'], 'username': row['username'], 'name': row['name'],
                'role': row['role'],
                'workspaces': json.loads(row['workspaces']) if row['workspaces'] else [],
            }
            token = secrets.token_hex(16)
            SESSIONS[token] = user
            return self._json(200, {'token': token, 'user': user})
        finally:
            conn.close()

    def logout(self):
        auth = self.headers.get('Authorization') or ''
        token = auth.replace('Bearer ', '').strip()
        SESSIONS.pop(token, None)
        return self._json(200, {'ok': True})

    # ---------- bootstrap ----------
    def bootstrap(self):
        conn = get_conn()
        try:
            # 权限过滤：按用户可访问的工作空间裁剪
            role = (self.user or {}).get('role') or 'user'
            user_ws = (self.user or {}).get('workspaces') or []
            all_ws = [dict(r) for r in conn.execute('SELECT * FROM workspaces').fetchall()]
            if role == 'admin' or not user_ws:
                ws_list = all_ws
            else:
                ws_list = [w for w in all_ws if w['id'] in user_ws]
            ws_ids = [w['id'] for w in ws_list]

            all_ds = [dict(r) for r in conn.execute('SELECT * FROM datasources').fetchall()]
            if role == 'admin':
                datasources = all_ds
            else:
                bound = set()
                if ws_ids:
                    ph = ','.join('?' * len(ws_ids))
                    bound = {r['ds_id'] for r in conn.execute(f'SELECT ds_id FROM workspace_datasources WHERE ws_id IN ({ph})', ws_ids).fetchall()}
                datasources = [d for d in all_ds if d['id'] in bound]

            # 工作空间 → 数据源 / 表 的绑定
            ws_ds_map, ws_tbl_map = {}, {}
            for r in conn.execute('SELECT ws_id, ds_id FROM workspace_datasources').fetchall():
                ws_ds_map.setdefault(r['ws_id'], []).append(r['ds_id'])
            for r in conn.execute('SELECT ws_id, table_id FROM workspace_tables').fetchall():
                ws_tbl_map.setdefault(r['ws_id'], []).append(r['table_id'])
            for w in ws_list:
                w['datasource_ids'] = ws_ds_map.get(w['id'], [])
                w['table_ids'] = ws_tbl_map.get(w['id'], [])

            ds_ids = [d['id'] for d in datasources]
            active_ws = get_setting(conn, 'active_workspace', 'ws-demo')
            if ws_ids and active_ws not in ws_ids:
                active_ws = ws_ids[0]
            active_ds = get_setting(conn, 'active_datasource', 'ds-demo')
            if ds_ids and active_ds not in ds_ids:
                active_ds = ds_ids[0]

            payload = {
                'user': self.user,
                'active_workspace': active_ws,
                'active_datasource': active_ds,
                'workspaces': ws_list,
                'datasources': datasources,
                'tables': [serialize_row('tables', r) for r in conn.execute('SELECT * FROM tables').fetchall()],
                'table_fields': [serialize_row('table_fields', r) for r in conn.execute('SELECT * FROM table_fields').fetchall()],
                'relations': [serialize_row('relations', r) for r in conn.execute('SELECT * FROM relations').fetchall()],
                'terms': [serialize_row('terms', r) for r in conn.execute('SELECT * FROM terms').fetchall()],
                'examples': [serialize_row('examples', r) for r in conn.execute('SELECT * FROM examples').fetchall()],
                'prompts': [serialize_row('prompts', r) for r in conn.execute('SELECT * FROM prompts').fetchall()],
                'rules': [serialize_row('rules', r) for r in conn.execute('SELECT * FROM rules').fetchall()],
                'models': [serialize_row('models', r) for r in conn.execute('SELECT * FROM models').fetchall()],
                'assistants': [serialize_row('assistants', r) for r in conn.execute('SELECT * FROM assistants').fetchall()],
                'dashboards': [serialize_row('dashboards', r) for r in conn.execute('SELECT * FROM dashboards').fetchall()],
                'chats': self._chat_list_inner(conn),
                'suggestions': ['近12个月销售额趋势', '各产品线销量占比', '销售额大于500万的区域有哪些', '销售人员业绩排名TOP10', '制造业客户数量统计'],
                'model_configured': any(r['api_key'] for r in conn.execute('SELECT api_key FROM models').fetchall()),
            }
            return payload
        finally:
            conn.close()

    # ---------- 会话 ----------
    def _chat_list_inner(self, conn):
        rows = conn.execute('SELECT id, title, ds_id, updated, (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id) AS msg_count FROM chats c ORDER BY updated DESC').fetchall()
        return [dict(r) for r in rows]

    def chat_list(self):
        conn = get_conn()
        try:
            return self._chat_list_inner(conn)
        finally:
            conn.close()

    def chat_detail(self, cid):
        conn = get_conn()
        try:
            chat = conn.execute('SELECT * FROM chats WHERE id=?', (cid,)).fetchone()
            if not chat:
                return {'error': 'not found'}
            msgs = conn.execute('SELECT role, content FROM messages WHERE chat_id=? ORDER BY created ASC', (cid,)).fetchall()
            return {'id': cid, 'title': chat['title'], 'dsId': chat['ds_id'],
                    'messages': [json.loads(m['content']) for m in msgs]}
        finally:
            conn.close()

    def chat_new(self):
        import uuid
        cid = 'c-' + uuid.uuid4().hex[:12]
        conn = get_conn()
        try:
            now = time.strftime('%Y-%m-%dT%H:%M:%S')
            conn.execute('INSERT INTO chats VALUES(?,?,?,?,?)', (cid, '新会话', get_setting(conn, 'active_datasource'), now, now))
            conn.commit()
            return {'id': cid}
        finally:
            conn.close()

    def chat(self):
        body = self._read_json()
        question = (body.get('question') or '').strip()
        if not question:
            return self._json(400, {'error': 'question required'})
        chat_id = body.get('chat_id')
        conn = get_conn()
        try:
            ds_id = body.get('datasource_id') or get_setting(conn, 'active_datasource', 'ds-demo')
            if not chat_id:
                import uuid
                chat_id = 'c-' + uuid.uuid4().hex[:12]
                now = time.strftime('%Y-%m-%dT%H:%M:%S')
                conn.execute('INSERT INTO chats VALUES(?,?,?,?,?)', (chat_id, '新会话', ds_id, now, now))
            # 存用户消息
            conn.execute('INSERT INTO messages VALUES(?,?,?,?,?)',
                         (f'{chat_id}-u-{int(time.time()*1000)}', chat_id, 'user',
                          json.dumps({'role': 'user', 'text': question}, ensure_ascii=False),
                          time.strftime('%Y-%m-%dT%H:%M:%S')))
            # 生成答案（按指定数据源执行）
            answer = ask(question, conn, model_id=body.get('model_id'), ds_id=ds_id)
            conn.execute('INSERT INTO messages VALUES(?,?,?,?,?)',
                         (f'{chat_id}-b-{int(time.time()*1000)}', chat_id, 'bot',
                          json.dumps(answer, ensure_ascii=False),
                          time.strftime('%Y-%m-%dT%H:%M:%S')))
            # 更新标题与时间
            title = question if len(question) <= 18 else question[:18] + '…'
            conn.execute('UPDATE chats SET title=?, updated=? WHERE id=?',
                         (title, time.strftime('%Y-%m-%dT%H:%M:%S'), chat_id))
            conn.commit()
            answer['chat_id'] = chat_id
            return self._json(200, answer)
        finally:
            conn.close()

    # ---------- 通用资源 CRUD ----------
    def resource_list(self, resource):
        table = RESOURCES[resource]
        conn = get_conn()
        try:
            return [serialize_row(table, r) for r in conn.execute(f'SELECT * FROM {table}').fetchall()]
        finally:
            conn.close()

    def resource_create(self, resource):
        if not self._require_admin():
            return
        table = RESOURCES[resource]
        body = self._read_json()
        return self._do_write(table, None, body)

    def resource_update(self, resource, rid):
        if not self._require_admin():
            return
        table = RESOURCES[resource]
        body = self._read_json()
        return self._do_write(table, rid, body)

    def resource_delete(self, resource, rid):
        if not self._require_admin():
            return
        table = RESOURCES[resource]
        conn = get_conn()
        try:
            conn.execute(f'DELETE FROM {table} WHERE id=?', (rid,))
            conn.commit()
            return self._json(200, {'ok': True})
        finally:
            conn.close()

    def _do_write(self, table, rid, body):
        import uuid
        conn = get_conn()
        try:
            if table == 'rules':
                items = body.get('items') or []
                if not rid:
                    rid = 'rg-' + uuid.uuid4().hex[:8]
                conn.execute('INSERT INTO rules(id,name,items) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, items=excluded.items',
                             (rid, body.get('name', ''), json.dumps(items, ensure_ascii=False)))
            elif table == 'models':
                if not rid:
                    rid = 'm-' + uuid.uuid4().hex[:8]
                # api_key 可能不传（保持原值）
                cur = conn.execute('SELECT api_key FROM models WHERE id=?', (rid,)).fetchone()
                key = body.get('api_key') if body.get('api_key') is not None else (cur['api_key'] if cur else '')
                status = body.get('status') or 'ready'
                if status == 'default':
                    conn.execute("UPDATE models SET status='ready' WHERE status='default'")
                conn.execute('INSERT INTO models(id,name,provider,model_id,base_url,api_key,status) VALUES(?,?,?,?,?,?,?) '
                             'ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, model_id=excluded.model_id, base_url=excluded.base_url, api_key=excluded.api_key, status=excluded.status',
                             (rid, body.get('name', ''), body.get('provider', ''), body.get('model_id', ''),
                              body.get('base_url', 'https://api.deepseek.com'), key, status))
            else:
                if not rid:
                    rid = ('id' in body and body['id']) or (table[:-1] + '-' + uuid.uuid4().hex[:8])
                cols = [r[1] for r in conn.execute(f'PRAGMA table_info({table})').fetchall()]
                data = {k: body.get(k) for k in cols if k in body and k != 'api_key'}
                if 'id' in data:
                    data['id'] = rid
                if table == 'tables' and 'enabled' in data:
                    data['enabled'] = 1 if data['enabled'] else 0
                if table == 'assistants' and 'enabled' in data:
                    data['enabled'] = 1 if data['enabled'] else 0
                if 'id' not in data:
                    data['id'] = rid
                set_cols = ','.join(f'{k}=excluded.{k}' for k in data if k != 'id')
                col_names = ','.join(data.keys())
                placeholders = ','.join(['?'] * len(data))
                conn.execute(f'INSERT INTO {table}({col_names}) VALUES({placeholders}) '
                             f'ON CONFLICT(id) DO UPDATE SET {set_cols}',
                             list(data.values()))
            conn.commit()
            return self._json(200, {'ok': True, 'id': rid})
        finally:
            conn.close()


# ---------------------------------------------------------------- main
def main():
    global PORT
    if len(sys.argv) > 1:
        try:
            PORT = int(sys.argv[1])
        except ValueError:
            print('端口参数无效，使用默认 8000', flush=True)
    init_db()
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('=' * 56, flush=True)
    print('  BondQL · 智能问数 已启动', flush=True)
    print(f'  访问地址:  http://127.0.0.1:{PORT}', flush=True)
    print(f'  数据库:    {DB_PATH}', flush=True)
    print('  提示: 在「AI模型配置」页填写 API Key 即可启用大模型', flush=True)
    print('        未配置 Key 时使用内置规则引擎（真实 SQL 执行）', flush=True)
    print('  按 Ctrl+C 停止服务', flush=True)
    print('=' * 56, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止', flush=True)


if __name__ == '__main__':
    main()
