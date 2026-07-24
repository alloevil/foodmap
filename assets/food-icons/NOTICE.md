# 图标来源

`food-icons/` 下的 PNG 图标截取自微软的 [Fluent Emoji](https://github.com/microsoft/fluentui-emoji)(3D 风格),MIT 协议:

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```

用到的 12 个(文件名对应原仓库里的 emoji 名称,下划线替换空格):

dumpling、oden、fried_shrimp（Fried shrimp）、curry_rice（Curry rice）、cooked_rice（Cooked rice）、bento_box（Bento box）、cut_of_meat（Cut of meat）、pancakes、fish、dango、cookie、fortune_cookie（Fortune cookie）。

按餐厅名哈希选一个,同一家店在标记/弹窗/侧栏始终显示同一个图标(见 `index.html` 里的 `pickFoodIcon`)。
