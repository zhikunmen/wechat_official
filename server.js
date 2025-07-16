const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const UserAgent = require('user-agents');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3303;

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "https://cdn.tailwindcss.com",
        "https://cdn.jsdelivr.net"
      ],
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "https://cdn.jsdelivr.net",
        "https://fonts.googleapis.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://cdn.jsdelivr.net"
      ],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  }
}));

// 速率限制器 - 每分钟最多30个请求
const rateLimiter = new RateLimiterMemory({
  keyPrefix: 'wechat_parser',
  points: 30, // 请求次数
  duration: 60, // 每60秒
});

// 速率限制中间件
const rateLimiterMiddleware = async (req, res, next) => {
  try {
    const clientIP = req.ip || req.connection.remoteAddress;
    await rateLimiter.consume(clientIP);
    next();
  } catch (rejRes) {
    res.status(429).json({
      success: false,
      error: '请求过于频繁，请稍后再试',
      retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 1,
    });
  }
};

// 中间件配置
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS配置
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 静态文件服务 - 为前端HTML文件提供服务，配置禁用缓存
app.use(express.static(__dirname, {
  // 开发环境禁用缓存
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    // 对HTML、CSS、JS文件禁用缓存
    if (path.endsWith('.html') || path.endsWith('.css') || path.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// 获取随机User-Agent
function getRandomUserAgent() {
  const userAgent = new UserAgent({ deviceCategory: 'desktop' });
  return userAgent.toString();
}

// 微信公众号URL验证
function isValidWechatUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.includes('mp.weixin.qq.com') && parsedUrl.pathname.includes('/s/');
  } catch (error) {
    return false;
  }
}

// 处理图片，确保正确显示
function processImages(content) {
  if (!content) return '';
  
  // 处理微信公众号的图片懒加载
  // 将data-src、data-original-src等转换为src
  content = content.replace(/<img([^>]*?)data-src="([^"]*?)"([^>]*?)>/gi, '<img$1src="$2"$3>');
  content = content.replace(/<img([^>]*?)data-original-src="([^"]*?)"([^>]*?)>/gi, '<img$1src="$2"$3>');
  content = content.replace(/<img([^>]*?)data-croporisrc="([^"]*?)"([^>]*?)>/gi, '<img$1src="$2"$3>');
  
  // 处理没有src但有其他data属性的图片
  content = content.replace(/<img(?![^>]*src=)([^>]*?)data-[^=]*src[^=]*="([^"]*?)"([^>]*?)>/gi, '<img$1src="$2"$3>');
  
  // 确保图片有alt属性
  content = content.replace(/<img(?![^>]*alt=)([^>]*?)>/gi, '<img$1 alt="文章图片">');
  
  // 为图片添加样式，确保响应式显示
  content = content.replace(/<img([^>]*?)>/gi, '<img$1 style="max-width: 100%; height: auto; display: block;">');
  
  return content;
}

// 清理和格式化内容，保留图片信息
function cleanContent(content) {
  if (!content) return '';
  
  // 首先处理图片
  content = processImages(content);
  
  // 移除微信特定的样式和脚本
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  // 清理不必要的data属性，但保留图片相关的
  content = content.replace(/data-(?!src|original-src|alt)[^=]*="[^"]*"/gi, '');
  
  // 移除大部分class和id，但保留可能与图片相关的
  content = content.replace(/class="(?!.*(?:img|image|photo|picture))[^"]*"/gi, '');
  content = content.replace(/id="(?!.*(?:img|image|photo|picture))[^"]*"/gi, '');
  
  // 清理多余的空白，但保持基本格式
  content = content.replace(/\s+/g, ' ').trim();
  content = content.replace(/>\s+</g, '><');
  
  return content;
}

// 提取文章内容的多种策略
function extractArticleContent($) {
  let title = '';
  let content = '';
  
  // 策略1：寻找标题
  const titleSelectors = [
    '#activity-name',
    '.rich_media_title',
    'h1.rich_media_title',
    '[id*="title"]',
    'h1',
    'h2'
  ];
  
  for (const selector of titleSelectors) {
    const titleElement = $(selector).first();
    if (titleElement.length && titleElement.text().trim()) {
      title = titleElement.text().trim();
      break;
    }
  }
  
  // 策略2：寻找正文内容
  const contentSelectors = [
    '#js_content',
    '.rich_media_content',
    '[id*="content"]',
    '.article-content',
    '.post-content',
    'main',
    'article'
  ];
  
  for (const selector of contentSelectors) {
    const contentElement = $(selector).first();
    if (contentElement.length) {
      // 移除不需要的元素，但保留图片
      contentElement.find('script, style, .comment, .share, .footer, .ad, .advertisement').remove();
      
      const htmlContent = contentElement.html();
      if (htmlContent && htmlContent.trim().length > 100) {
        // 统计图片数量
        const imageCount = (htmlContent.match(/<img[^>]*>/gi) || []).length;
        console.log(`找到 ${imageCount} 张图片`);
        
        content = cleanContent(htmlContent);
        break;
      }
    }
  }
  
  // 策略3：如果仍然没有找到内容，尝试获取所有段落和图片
  if (!content) {
    const paragraphs = $('p').map((i, el) => $(el).html()).get();
    const images = $('img').map((i, el) => $.html(el)).get();
    
    if (paragraphs.length > 0 || images.length > 0) {
      const allContent = [...paragraphs, ...images].join('');
      content = cleanContent(allContent);
    }
  }
  
  return { title, content };
}

// 解析微信公众号文章
async function parseWechatArticle(url) {
  try {
    console.log(`开始解析文章: ${url}`);
    
    // 配置请求头，模拟真实浏览器
    const headers = {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
      'Referer': 'https://mp.weixin.qq.com/',
    };
    
    // 发送请求
    const response = await axios.get(url, {
      headers,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: function (status) {
        return status < 500; // 允许4xx状态码
      }
    });
    
    console.log(`响应状态: ${response.status}`);
    
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: 无法访问文章`);
    }
    
    const html = response.data;
    
    // 检查是否遇到验证页面
    if (html.includes('环境异常') || html.includes('完成验证') || html.includes('verification')) {
      console.log('检测到验证页面');
      return {
        title: '示例文章标题（验证受限）',
        content: `
          <div style="text-align: center; padding: 40px; color: #666;">
            <h2>⚠️ 访问受限</h2>
            <p>当前微信公众号文章需要完成人机验证，无法自动获取内容。</p>
            <p>这是一个演示内容，您可以手动复制文章内容到编辑器中进行编辑。</p>
            <br>
            <h3>演示功能：</h3>
            <ul style="text-align: left; max-width: 400px; margin: 0 auto;">
              <li>富文本编辑器</li>
              <li>实时预览功能</li>
              <li>多种HTML模板</li>
              <li>图片上传和管理</li>
              <li>一键导出HTML</li>
            </ul>
            <p style="margin-top: 20px; font-size: 14px; color: #999;">
              原文链接：<a href="${url}" target="_blank">${url}</a>
            </p>
          </div>
        `
      };
    }
    
    // 使用cheerio解析HTML
    const $ = cheerio.load(html);
    
    // 提取文章内容
    const { title, content } = extractArticleContent($);
    
    if (!title && !content) {
      throw new Error('未找到有效的文章内容');
    }
    
    // 提取图片信息
    const imageUrls = [];
    const imageMatches = content.match(/<img[^>]*src="([^"]*)"[^>]*>/gi);
    if (imageMatches) {
      imageMatches.forEach(match => {
        const srcMatch = match.match(/src="([^"]*)"/);
        if (srcMatch && srcMatch[1]) {
          imageUrls.push(srcMatch[1]);
        }
      });
    }
    
    console.log(`成功解析文章: ${title}`);
    console.log(`提取到 ${imageUrls.length} 张图片:`, imageUrls.slice(0, 3)); // 只显示前3张图片的URL
    
    return {
      title: title || '微信公众号文章',
      content: content || '<p>文章内容解析中，请稍候...</p>',
      images: imageUrls,
      stats: {
        imageCount: imageUrls.length,
        contentLength: content.length
      }
    };
    
  } catch (error) {
    console.error('解析文章失败:', error.message);
    
    // 返回友好的错误信息和示例内容
    return {
      title: '解析失败 - 示例内容',
      content: `
        <div style="border: 2px dashed #ccc; padding: 30px; margin: 20px 0; border-radius: 8px; background: #fafafa;">
          <h2 style="color: #e74c3c; margin-bottom: 15px;">🚫 内容获取失败</h2>
          <p><strong>错误信息：</strong>${error.message}</p>
          <p><strong>原文链接：</strong><a href="${url}" target="_blank">${url}</a></p>
          
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
          
          <h3>💡 使用建议：</h3>
          <ol>
            <li>请检查链接是否正确且可访问</li>
            <li>部分公众号文章需要关注后才能查看</li>
            <li>您可以手动复制文章内容到编辑器</li>
            <li>尝试使用其他公众号文章链接测试</li>
          </ol>
          
          <h3>🎯 功能演示：</h3>
          <p>即使无法获取真实内容，您仍然可以体验我们强大的编辑功能：</p>
          <ul>
            <li><strong>富文本编辑：</strong>支持标题、段落、列表等格式</li>
            <li><strong>图片管理：</strong>上传本地图片或使用网络链接</li>
            <li><strong>实时预览：</strong>随时查看编辑效果</li>
            <li><strong>多种模板：</strong>基础、博客、邮件、微信模板</li>
            <li><strong>一键导出：</strong>生成完整的HTML文件</li>
          </ul>
          
          <p style="margin-top: 20px; font-style: italic; color: #666;">
            您可以在编辑器中修改这段内容，体验所有功能特性！
          </p>
        </div>
      `
    };
  }
}

// API路由

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '微信公众号解析服务运行正常',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// 解析微信公众号文章
app.post('/api/wechat/parse', rateLimiterMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: '请提供微信公众号文章链接'
      });
    }
    
    if (!isValidWechatUrl(url)) {
      return res.status(400).json({
        success: false,
        error: '请提供有效的微信公众号文章链接'
      });
    }
    
    const result = await parseWechatArticle(url);
    
    res.json({
      success: true,
      data: {
        title: result.title,
        content: result.content,
        url: url,
        parsedAt: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('API错误:', error);
    res.status(500).json({
      success: false,
      error: '服务器内部错误，请稍后重试'
    });
  }
});

// 服务主页 - 返回前端HTML文件
app.get('/', (req, res) => {
  // 设置防缓存头
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // 添加自定义响应头，包含当前时间戳用于调试
  res.setHeader('X-Timestamp', Date.now().toString());
  res.setHeader('X-Cache-Buster', `v${Date.now()}`);
  
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在'
  });
});

// 错误处理中间件
app.use((error, req, res, next) => {
  console.error('全局错误:', error);
  res.status(500).json({
    success: false,
    error: '服务器内部错误'
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`
🚀 微信公众号解析服务已启动
📍 端口: ${PORT}
🌐 访问地址: http://localhost:${PORT}
📖 API文档: http://localhost:${PORT}/api/health
⏰ 启动时间: ${new Date().toLocaleString('zh-CN')}
  `);
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n👋 正在关闭服务器...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 正在关闭服务器...');
  process.exit(0);
}); 