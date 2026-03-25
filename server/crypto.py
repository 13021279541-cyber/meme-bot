"""
企业微信消息加解密工具

基于企业微信官方加解密方案，使用 AES-CBC-256 加解密。
参考文档：https://developer.work.weixin.qq.com/document/path/90968
"""
import base64
import hashlib
import struct
import time
import random
import string
import xml.etree.ElementTree as ET

from Crypto.Cipher import AES


class WeComCrypto:
    """企业微信消息加解密类"""

    def __init__(self, token: str, encoding_aes_key: str, corp_id: str):
        self.token = token
        self.corp_id = corp_id
        # EncodingAESKey 是 base64 编码的 AES 密钥，解码后得到 32 字节密钥
        self.aes_key = base64.b64decode(encoding_aes_key + "=")

    def verify_url(self, msg_signature: str, timestamp: str, nonce: str, echostr: str) -> str:
        """
        验证回调 URL（首次配置时企微会发一个验证请求）
        
        Returns:
            解密后的 echostr，需要直接返回给企微
        """
        # 1. 验证签名
        if not self._check_signature(msg_signature, timestamp, nonce, echostr):
            raise ValueError("签名验证失败")
        
        # 2. 解密 echostr
        decrypted = self._decrypt(echostr)
        return decrypted

    def decrypt_message(self, msg_signature: str, timestamp: str, nonce: str, post_data: str) -> str:
        """
        解密接收到的消息
        
        Args:
            msg_signature: 消息签名
            timestamp: 时间戳
            nonce: 随机数
            post_data: POST 请求体（XML 格式）
        
        Returns:
            解密后的 XML 消息内容
        """
        # 1. 从 XML 中提取加密消息
        xml_tree = ET.fromstring(post_data)
        encrypt = xml_tree.find("Encrypt").text

        # 2. 验证签名
        if not self._check_signature(msg_signature, timestamp, nonce, encrypt):
            raise ValueError("消息签名验证失败")
        
        # 3. 解密消息
        return self._decrypt(encrypt)

    def encrypt_message(self, reply_msg: str, timestamp: str = None, nonce: str = None) -> str:
        """
        加密回复消息
        
        Args:
            reply_msg: 要回复的消息内容
            timestamp: 时间戳（不传则自动生成）
            nonce: 随机数（不传则自动生成）
        
        Returns:
            加密后的 XML 字符串
        """
        if timestamp is None:
            timestamp = str(int(time.time()))
        if nonce is None:
            nonce = ''.join(random.choices(string.digits, k=10))

        # 1. 加密消息
        encrypted = self._encrypt(reply_msg)

        # 2. 生成签名
        signature = self._generate_signature(timestamp, nonce, encrypted)

        # 3. 构造 XML
        resp_xml = f"""<xml>
<Encrypt><![CDATA[{encrypted}]]></Encrypt>
<MsgSignature><![CDATA[{signature}]]></MsgSignature>
<TimeStamp>{timestamp}</TimeStamp>
<Nonce><![CDATA[{nonce}]]></Nonce>
</xml>"""
        return resp_xml

    def _check_signature(self, msg_signature: str, timestamp: str, nonce: str, encrypt: str) -> bool:
        """验证签名"""
        expected = self._generate_signature(timestamp, nonce, encrypt)
        return msg_signature == expected

    def _generate_signature(self, timestamp: str, nonce: str, encrypt: str) -> str:
        """生成签名"""
        sort_list = sorted([self.token, timestamp, nonce, encrypt])
        raw = ''.join(sort_list).encode('utf-8')
        return hashlib.sha1(raw).hexdigest()

    def _decrypt(self, encrypted_text: str) -> str:
        """AES 解密"""
        cipher = AES.new(self.aes_key, AES.MODE_CBC, self.aes_key[:16])
        decrypted = cipher.decrypt(base64.b64decode(encrypted_text))

        # 去除 PKCS#7 填充
        pad_len = decrypted[-1]
        content = decrypted[:-pad_len]

        # 前 16 字节是随机字符串，接下来 4 字节是消息长度，然后是消息内容，最后是 corp_id
        msg_len = struct.unpack('>I', content[16:20])[0]
        msg = content[20:20 + msg_len].decode('utf-8')
        from_corp_id = content[20 + msg_len:].decode('utf-8')

        if from_corp_id != self.corp_id:
            raise ValueError(f"CorpID 不匹配: 期望 {self.corp_id}, 收到 {from_corp_id}")
        
        return msg

    def _encrypt(self, text: str) -> str:
        """AES 加密"""
        # 随机 16 字节 + 消息长度(4字节) + 消息内容 + corp_id
        random_str = ''.join(random.choices(string.ascii_letters + string.digits, k=16)).encode('utf-8')
        text_bytes = text.encode('utf-8')
        content = random_str + struct.pack('>I', len(text_bytes)) + text_bytes + self.corp_id.encode('utf-8')

        # PKCS#7 填充到 32 的倍数
        block_size = 32
        pad_len = block_size - (len(content) % block_size)
        content += bytes([pad_len]) * pad_len

        cipher = AES.new(self.aes_key, AES.MODE_CBC, self.aes_key[:16])
        encrypted = cipher.encrypt(content)
        return base64.b64encode(encrypted).decode('utf-8')
