"""供应商实现。**只被 ``qiuqiu_models.registry`` import**（AD-8）。

这里不做任何 re-export：上层要拿实例请走 ``registry.get(capability)``，
这样换供应商只改注册表一处。
"""
